/**
 * Provider orchestration for bridging pi requests to the Claude CLI subprocess.
 *
 * streamViaCli is the core function that:
 * 1. Builds the prompt from conversation context (replay or resume)
 * 2. Starts a one-request relay and spawns an isolated Claude CLI subprocess
 *    pointed at it
 * 3. Writes the user message to stdin as NDJSON
 * 4. Reads stdout line-by-line, parsing NDJSON
 * 5. Routes stream events through the event bridge to pi's stream
 * 6. Handles result/error messages, upstream and login failures, and cleans
 *    up the subprocess, relay and MCP config file
 * 7. Implements break-early: kills subprocess at message_stop when any
 *    tool_use block was seen, so pi runs the tools
 * 8. Hardened lifecycle: inactivity and per-request timeouts, subprocess exit
 *    handler, streamEnded guard, abort via SIGKILL, process registry
 * 9. Falls back from resume to replay when the session is gone
 */

import { createInterface } from "node:readline";
import {
  AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import {
  buildPrompt,
  buildReplayPrompt,
  buildSystemPrompt,
  buildResumePrompt,
  findUnsupportedAttachment,
  findRepeatedToolFailure,
} from "./prompt-builder.js";
import { getPiToolNames, isInternalClaudeTool } from "./tool-mapping.js";
import {
  spawnClaude,
  writeUserMessage,
  cleanupProcess,
  captureStderr,
  forceKillProcess,
  registerProcess,
  getRequestTimeoutMs,
} from "./process-manager.js";
import { parseLine } from "./stream-parser.js";
import { createEventBridge } from "./event-bridge.js";
import {
  startRelay,
  describeFailure,
  type Relay,
  type UpstreamFailure,
} from "./relay.js";
import { removeMcpConfig } from "./mcp-config.js";
import { handleControlRequest } from "./control-handler.js";
import { mapThinkingEffort } from "./thinking-config.js";
import { getSessionMode } from "./session-mode.js";
/** Inactivity timeout: kill subprocess if no stdout for 180 seconds (3 minutes). */
const INACTIVITY_TIMEOUT_MS = 180_000;

/** What the CLI reports as its result when no login is stored. */
const NOT_LOGGED_IN = /Not logged in/i;

/** What the CLI prints when `--resume` finds no readable session. */
const SESSION_NOT_FOUND = /No conversation found with session ID/;

/** Extended stream options: pi's SimpleStreamOptions plus optional cwd and mcpConfigPath */
type StreamViaCLiOptions = SimpleStreamOptions & {
  cwd?: string;
  mcpConfigPath?: string;
};

/**
 * Stream a response from Claude CLI as an AssistantMessageEventStream.
 *
 * Orchestrates the full subprocess lifecycle: spawn, write prompt, parse NDJSON,
 * bridge events, handle result, and clean up. Implements break-early pattern:
 * at message_stop, if any tool call was seen, kills the subprocess before
 * Claude CLI can auto-execute the tools.
 *
 * Hardened with: inactivity timeout (180s), subprocess exit handler with stderr
 * surfacing, streamEnded guard against double errors, abort via SIGKILL, and
 * process registry integration for teardown cleanup.
 *
 * @param model - The model to use (from pi's model catalog)
 * @param context - The conversation context with messages and system prompt
 * @param options - Optional cwd, abort signal, reasoning level, thinking budgets, and mcpConfigPath
 * (a writeMcpConfig file, removed when the request ends)
 * @returns An AssistantMessageEventStream that receives bridged events
 */
export function streamViaCli(
  model: Model<any>,
  context: {
    messages: any[];
    systemPrompt?: string;
    tools?: { name: string }[];
  },
  options?: StreamViaCLiOptions,
): AssistantMessageEventStream {
  // @ts-expect-error — tsc can't verify AssistantMessageEventStream is a value
  // through pi-ai's `export *` re-export chain. The class constructor exists at runtime.
  const stream = new AssistantMessageEventStream();

  /**
   * One CLI attempt. Resolves true when a resumed session was missing or
   * corrupt and nothing was sent, so the caller can retry as replay.
   */
  const attempt = async (forceReplay: boolean): Promise<boolean> => {
    let proc: ReturnType<typeof spawnClaude> | undefined;
    let abortHandler: (() => void) | undefined;
    let relay: Relay | undefined;
    // The CLI refused to start a request because no login is stored
    let notLoggedIn = false;
    let stopRequestTimer: (() => void) | undefined;

    try {
      const cwd = options?.cwd ?? process.cwd();

      // End the stream before anything is spawned
      const endWithoutCli = (text?: string) => {
        const output = createEventBridge(stream, model).getOutput();
        stream.push({
          type: "done",
          reason: "stop",
          message: {
            ...output,
            ...(text && { content: [{ type: "text", text }] }),
          },
        });
        stream.end();
      };

      // Pi already cancelled: nothing to start
      if (options?.signal?.aborted) {
        endWithoutCli();
        return false;
      }

      // Reject attachments the CLI path cannot carry, before spawning anything
      const unsupported = findUnsupportedAttachment(context.messages);
      if (unsupported) {
        endWithoutCli(`Error: ${unsupported}`);
        return false;
      }

      // Stop a model stuck re-issuing the same failing tool call
      const repeated = findRepeatedToolFailure(context.messages);
      if (repeated) {
        endWithoutCli(`Error: ${repeated}`);
        return false;
      }

      // Replay (default) rebuilds the full history into one stateless call.
      // Resume reuses a CLI session, but only once one exists on disk: pi
      // passes sessionId on every call (including first), so the first turn
      // creates the session and later turns --resume it. Only an assistant
      // message indicates a prior turn, not the total transcript length
      // (pi includes system messages on the first turn).
      const replay = forceReplay || getSessionMode() === "replay";
      const resumeSessionId =
        !replay &&
        options?.sessionId &&
        context.messages.some((message) => message.role === "assistant")
          ? options.sessionId
          : undefined;

      // When resuming, only send the latest user turn
      const prompt = replay
        ? buildReplayPrompt(context)
        : resumeSessionId
          ? buildResumePrompt(context)
          : buildPrompt(context);
      const systemPrompt = buildSystemPrompt(context, cwd, replay);

      // Compute effort level from reasoning options
      const effort = mapThinkingEffort(
        options?.reasoning,
        model.id,
        options?.thinkingBudgets,
      );

      // One-request relay between the CLI and Anthropic
      relay = await startRelay();

      // Pi may have cancelled while the relay was starting: don't spawn
      if (options?.signal?.aborted) {
        endWithoutCli();
        return false;
      }

      // Spawn subprocess
      proc = spawnClaude(model.id, systemPrompt || undefined, {
        signal: options?.signal,
        effort,
        mcpConfigPath: options?.mcpConfigPath,
        resumeSessionId,
        newSessionId:
          !replay && !resumeSessionId ? options?.sessionId : undefined,
        stateless: replay,
        baseUrl: relay.url,
      });
      const getStderr = captureStderr(proc);

      // Register in global process registry for teardown cleanup
      registerProcess(proc);

      // Write user message to subprocess stdin
      writeUserMessage(proc, prompt);

      // Create event bridge (before endStreamWithError so bridge is in scope)
      const bridge = createEventBridge(
        stream,
        model,
        getPiToolNames(context),
      );

      // Guard against double stream.end() and double error events.
      // First error path wins; subsequent ones are no-ops.
      let streamEnded = false;
      // Set once break-early kills the subprocess; guards buffered readline lines
      let broken = false;
      // Set once the CLI reports its result; a later kill is our own cleanup
      let resultSeen = false;

      /**
       * End the stream with an error, using a "done" event instead of "error".
       *
       * Why "done" not "error": AssistantMessageEventStream.extractResult()
       * returns event.error (a string) for error events, but agent-loop.js
       * then calls message.content.filter() on the result, crashing because
       * a string has no .content property. By pushing "done" with a valid
       * AssistantMessage (content:[]), pi gets a well-formed object.
       */
      function endStreamWithError(errMsg: string) {
        if (streamEnded || broken) return;
        streamEnded = true;
        const output = bridge.getOutput();
        const failure: UpstreamFailure | undefined =
          relay?.failure ?? (notLoggedIn ? { status: 401 } : undefined);
        if (failure) {
          // Upstream and login failures end as a real error, so Pi can retry
          // the retryable ones and stop on the others.
          stream.push({
            type: "error",
            reason: "error",
            error: {
              ...output,
              stopReason: "error",
              errorMessage: describeFailure(failure),
            },
          } as any);
          stream.end();
          return;
        }
        const errorMessage = {
          ...output,
          content: output.content?.length
            ? output.content
            : [{ type: "text" as const, text: `Error: ${errMsg}` }],
          stopReason: "stop" as const,
        };
        stream.push({
          type: "done",
          reason: "stop",
          message: errorMessage,
        } as any);
        stream.end();
      }

      // Inactivity timeout: kill subprocess if no stdout for INACTIVITY_TIMEOUT_MS
      let inactivityTimer: ReturnType<typeof setTimeout> | undefined;

      function resetInactivityTimer() {
        if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          forceKillProcess(proc!);
          endStreamWithError(
            `Claude CLI subprocess timed out: no output for ${INACTIVITY_TIMEOUT_MS / 1000} seconds`,
          );
        }, INACTIVITY_TIMEOUT_MS);
      }

      // Per-request timeout: kill the whole process tree, then end as usual
      const requestTimeoutMs = getRequestTimeoutMs();
      const requestTimer = setTimeout(() => {
        forceKillProcess(proc!);
        endStreamWithError(
          `Claude CLI request timed out after ${requestTimeoutMs / 1000} seconds`,
        );
      }, requestTimeoutMs);
      requestTimer.unref();
      stopRequestTimer = () => clearTimeout(requestTimer);

      // Set up abort signal handler -- uses SIGKILL for immediate force-kill
      if (options?.signal) {
        abortHandler = () => {
          if (proc) {
            forceKillProcess(proc);
          }
        };

        // Aborted while the relay started: the kill closes stdout and ends the stream
        if (options.signal.aborted) abortHandler();
        else
          options.signal.addEventListener("abort", abortHandler, {
            once: true,
          });
      }

      // Track tool_use blocks for break-early decision at message_stop
      let sawToolCall = false;
      // Set up readline for line-by-line NDJSON parsing
      const rl = createInterface({
        input: proc.stdout!,
        crlfDelay: Infinity,
        terminal: false,
      });

      // Handle process error -- use endStreamWithError for guard
      proc.on("error", (err: Error) => {
        if (broken) return; // Break-early killed the process intentionally
        const stderr = getStderr();
        endStreamWithError(stderr || err.message);
      });

      // Handle subprocess close -- surface crashes with stderr and exit code
      proc.on("close", (code: number | null, signal: string | null) => {
        clearTimeout(inactivityTimer);
        if (broken) return; // Break-early kill, expected
        if (code === null) {
          // Killed by a signal: not an abort or our own cleanup, so report it
          if (resultSeen || options?.signal?.aborted) return;
          const stderr = getStderr().trim();
          endStreamWithError(
            stderr || `Claude CLI was killed by signal ${signal ?? "unknown"}`,
          );
          return;
        }
        if (code !== 0) {
          const stderr = getStderr();
          if (resumeLost(stderr)) return; // The caller falls back to replay
          const message = stderr
            ? `Claude CLI exited with code ${code}: ${stderr.trim()}`
            : `Claude CLI exited unexpectedly with code ${code}`;
          endStreamWithError(message);
        }
      });

      // A resumed session that is gone or unreadable fails before any output
      // and before any request upstream (a replay must not be a second one)
      const resumeLost = (stderr: string) =>
        !!resumeSessionId &&
        relay?.upstreamCount === 0 &&
        SESSION_NOT_FOUND.test(stderr) &&
        !bridge.getOutput().content?.length;

      // Start inactivity timer after writing user message
      resetInactivityTimer();

      // Process NDJSON lines from stdout using event-based callback
      // NOTE: Using 'line' event instead of `for await` because the async
      // iterator batches lines, breaking real-time streaming to pi.
      rl.on("line", (line: string) => {
        if (broken) return; // Guard: ignore buffered lines after break-early

        // Reset inactivity timer on each line of output
        resetInactivityTimer();

        const msg = parseLine(line);
        if (!msg) return;

        if (msg.type === "stream_event") {
          // Only forward top-level events to pi's event bridge.
          // Sub-agent events (parent_tool_use_id !== null) are internal to the CLI.
          const isTopLevel = !(msg as any).parent_tool_use_id;
          if (isTopLevel) {
            bridge.handleEvent(msg.event);
          }

          // Track tool_use blocks for break-early decision (top-level only)
          if (
            isTopLevel &&
            msg.event.type === "content_block_start" &&
            msg.event.content_block?.type === "tool_use" &&
            !isInternalClaudeTool(msg.event.content_block.name ?? "")
          ) {
            // Every tool call pi can see counts, offered or not; pi reports unknown ones
            sawToolCall = true;
          }

          // Break-early at message_stop: kill subprocess before CLI auto-executes tools
          // Only on top-level message_stop — sub-agent message_stop is internal
          if (isTopLevel && msg.event.type === "message_stop" && sawToolCall) {
            broken = true; // Set guard BEFORE rl.close() to prevent buffered lines
            clearTimeout(inactivityTimer);
            // Pi will execute these tools. Kill subprocess to prevent CLI from executing them.
            forceKillProcess(proc!);
            rl.close();
            return; // Don't process further -- done event already pushed by event bridge
          }
        } else if (msg.type === "control_request") {
          handleControlRequest(msg, proc!.stdin!);
        } else if (msg.type === "result") {
          resultSeen = true;
          if (msg.is_error && NOT_LOGGED_IN.test(msg.result ?? "")) {
            notLoggedIn = true;
            endStreamWithError(msg.result!);
          } else if (msg.is_error || msg.subtype.startsWith("error")) {
            endStreamWithError(
              msg.error ||
                msg.errors?.join("\n") ||
                "Unknown error from Claude CLI",
            );
          }
          // For both success and error: clean up the subprocess
          clearTimeout(inactivityTimer);
          cleanupProcess(proc!);
          rl.close();
        }
      });

      // Wait for readline to close (result received or process ended)
      await new Promise<void>((resolve) => {
        rl.on("close", resolve);
      });

      // stdout can close before the exit code and stderr are in
      if (!streamEnded && !resultSeen && !bridge.getOutput().content?.length) {
        await new Promise<void>((resolve) =>
          proc!.exitCode !== null || proc!.signalCode != null
            ? resolve()
            : proc!.once("close", resolve),
        );
        if (resumeSessionId && proc.exitCode !== 0 && resumeLost(getStderr()))
          return true;
      }

      // Push done event after readline closes (async). Pushing synchronously
      // inside handleMessageStop prevents pi from executing tools.
      // Guard with streamEnded to avoid pushing done after an error was already pushed.
      if (
        !streamEnded &&
        relay.failure &&
        !bridge.getOutput().content?.length
      ) {
        endStreamWithError("");
      }
      if (!streamEnded) {
        const output = bridge.getOutput();

        // A thinking-only reply (no text, no tool call) leaves Pi with nothing
        // to act on; the empty-signature thinking block can't be replayed
        // either. End it as a real error so Pi can retry or report it.
        const blocks = output.content ?? [];
        const onlyEmptyThinking =
          blocks.length > 0 &&
          blocks.every(
            (b: any) =>
              b.type === "thinking" &&
              !b.thinking &&
              !b.thinkingSignature,
          );
        if (onlyEmptyThinking) {
          streamEnded = true;
          stream.push({
            type: "error",
            reason: "error",
            error: {
              ...output,
              content: [],
              stopReason: "error",
              errorMessage:
                "Claude returned an empty reply (thinking only, no text or tool call).",
            },
          } as any);
          stream.end();
          return false;
        }

        streamEnded = true;
        stream.push({
          type: "done",
          // The bridge only ever sets these three
          reason: output.stopReason as "stop" | "length" | "toolUse",
          message: output,
        });
        stream.end();
      }
    } catch (err: any) {
      stream.push({
        type: "error",
        reason: "error",
        error: err.message ?? "Unexpected error in streamViaCli",
      } as any);
      stream.end();
    } finally {
      stopRequestTimer?.();
      // Clean up abort listener
      if (options?.signal && abortHandler) {
        options.signal.removeEventListener("abort", abortHandler);
      }
      await relay?.stop();
    }
    return false;
  };

  (async () => {
    try {
      if (await attempt(false)) await attempt(true);
    } finally {
      // The config file is made per request, and both attempts have used it
      if (options?.mcpConfigPath) removeMcpConfig(options.mcpConfigPath);
    }
  })();

  return stream;
}
