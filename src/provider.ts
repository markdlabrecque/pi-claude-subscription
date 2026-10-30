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
 *    handler, one typed terminal result per request, abort reported as a
 *    typed cancellation before a SIGKILL, process registry
 * 9. Falls back from resume to replay when the session is gone
 */

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
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
import { createAssistantOutput, createEventBridge } from "./event-bridge.js";
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
import { isDebugEnabled } from "./debug-log.js";
import { resolveEnv } from "./env-flag.js";
import {
  startRequestDiagnostics,
  type TerminalReason,
} from "./request-diagnostics.js";
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
 * surfacing, a request-wide guard against a second terminal result, abort via
 * SIGKILL, and process registry integration for teardown cleanup.
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
  const stream = createAssistantMessageEventStream();
  // Settings, relay upstream and CLI environment all come from this one
  // request-local view; process.env is never written
  const env = resolveEnv(options?.env);

  // One terminal result per request, across both attempts: the first wins
  let ended = false;

  /**
   * End the request as a typed error. The message keeps any partial content
   * and measured usage; errorMessage carries the diagnostic.
   */
  const endWithError = (output: AssistantMessage, errorMessage: string) => {
    if (ended) return;
    ended = true;
    stream.push({
      type: "error",
      reason: "error",
      error: { ...output, stopReason: "error", errorMessage },
    });
    stream.end();
  };

  /**
   * End the request as cancelled by Pi. The message keeps any partial
   * content and measured usage.
   */
  const endWithAbort = (output: AssistantMessage) => {
    if (ended) return;
    ended = true;
    stream.push({
      type: "error",
      reason: "aborted",
      error: {
        ...output,
        stopReason: "aborted",
        errorMessage: "Request was aborted",
      },
    });
    stream.end();
  };

  /** End the request successfully with the accumulated message. */
  const endWithDone = (output: AssistantMessage) => {
    if (ended) return;
    ended = true;
    stream.push({
      type: "done",
      // The bridge only ever sets these three
      reason: output.stopReason as "stop" | "length" | "toolUse",
      message: output,
    });
    stream.end();
  };

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
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    let closeLines: (() => void) | undefined;
    // Releases a wait on Pi's stream observer, so cancel can't be held by it
    let interruptQueue: (() => void) | undefined;
    // Set once break-early kills the subprocess; guards buffered readline lines
    let broken = false;
    // Set once the CLI reports its result; a later kill is our own cleanup
    let resultSeen = false;
    // What happened to this request, for the debug diagnostics record
    let diagnostics: ReturnType<typeof startRequestDiagnostics> | undefined;
    // The bridge's accumulated message, so a thrown failure still keeps it
    let output: AssistantMessage | undefined;
    const seen = {
      messageStart: false,
      messageStop: false,
      resultError: false,
      cancelled: false,
      timedOut: false,
      inactive: false,
      resumeLost: false,
      threw: false,
    };

    try {
      const bridge = createEventBridge(stream, model, getPiToolNames(context));
      output = bridge.getOutput();

      // Cancellation settles the request first, then tears down whatever
      // has started; later callbacks find the request already ended
      if (options?.signal) {
        abortHandler = () => {
          // A request that already ended keeps its own outcome
          if (!ended) seen.cancelled = true;
          endWithAbort(bridge.getOutput());
          interruptQueue?.();
          if (proc) forceKillProcess(proc);
          closeLines?.();
        };

        // Pi already cancelled: nothing to start
        if (options.signal.aborted) {
          abortHandler();
          return false;
        }
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      // Reject attachments the CLI path cannot carry, before spawning anything
      const unsupported = findUnsupportedAttachment(context.messages);
      if (unsupported) {
        endWithError(output, unsupported);
        return false;
      }

      // Stop a model stuck re-issuing the same failing tool call
      const repeated = findRepeatedToolFailure(context.messages);
      if (repeated) {
        endWithError(output, repeated);
        return false;
      }

      // Replay (default) rebuilds the full history into one stateless call.
      // Resume reuses a CLI session, but only once one exists on disk: pi
      // passes sessionId on every call (including first), so the first turn
      // creates the session and later turns --resume it. Only an assistant
      // message indicates a prior turn, not the total transcript length
      // (pi includes system messages on the first turn).
      const replay = forceReplay || getSessionMode(env) === "replay";
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
      const systemPrompt = buildSystemPrompt(context, replay);

      // Compute effort level from reasoning options
      const effort = mapThinkingEffort(
        options?.reasoning,
        model.id,
        options?.thinkingBudgets,
      );

      if (isDebugEnabled()) diagnostics = startRequestDiagnostics();

      // One-request relay between the CLI and Anthropic. Pi's request and
      // response hooks run there, on the actual request and response.
      const { onPayload, onResponse } = options ?? {};
      relay = await startRelay({
        upstream: env.ANTHROPIC_BASE_URL,
        onPayload: onPayload && ((payload) => onPayload(payload, model)),
        onResponse: onResponse && ((response) => onResponse(response, model)),
      });

      // Pi may have cancelled while the relay was starting: don't spawn
      if (options?.signal?.aborted) {
        endWithAbort(output);
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
        env,
      });
      const getStderr = captureStderr(proc);

      // Register in global process registry for teardown cleanup
      registerProcess(proc);

      // Write user message to subprocess stdin
      writeUserMessage(proc, prompt);

      // Pi's provider stream observer. With one, each top-level CLI stream
      // event waits for it before the bridge sees it, so lines (and the exit)
      // are handled in arrival order through `queue`.
      const observe = options?.onProviderStreamEvent;
      let observerFailure: string | undefined;
      let queue: Promise<void> = Promise.resolve();
      // Settles on cancel or timeout, so a stuck observer can't hold cleanup
      let interrupt!: () => void;
      const interrupted = new Promise<void>((resolve) => (interrupt = resolve));
      interruptQueue = interrupt;
      const inOrder = (handle: () => void | Promise<void>) => {
        if (!observe) return void handle();
        queue = queue
          .then(() => (seen.cancelled || ended ? undefined : handle()))
          .catch((err) => {
            observerFailure ??= `Provider stream event hook failed: ${err instanceof Error ? err.message : String(err)}`;
            forceKillProcess(proc!);
            endStreamWithError(observerFailure);
          });
      };
      const drained = () => Promise.race([queue, interrupted]);

      /**
       * End the request as a typed error, after any partial content. Upstream
       * and login failures use their mapped diagnostic, so Pi can retry the
       * retryable ones and stop on the others.
       */
      function endStreamWithError(errMsg: string) {
        if (broken) return;
        // A Pi hook failed or the relay refused the request: say so, as an error
        const refused = relay?.requestFailure ?? observerFailure;
        if (refused) {
          endWithError(bridge.getOutput(), refused);
          return;
        }
        const failure: UpstreamFailure | undefined =
          relay?.failure ?? (notLoggedIn ? { status: 401 } : undefined);
        endWithError(
          bridge.getOutput(),
          failure ? describeFailure(failure) : errMsg,
        );
      }

      // Inactivity timeout: kill subprocess if no stdout for INACTIVITY_TIMEOUT_MS
      function resetInactivityTimer() {
        if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          seen.inactive = true;
          interrupt();
          forceKillProcess(proc!);
          endStreamWithError(
            `Claude CLI subprocess timed out: no output for ${INACTIVITY_TIMEOUT_MS / 1000} seconds`,
          );
        }, INACTIVITY_TIMEOUT_MS);
      }

      // Per-request timeout: kill the whole process tree, then end as usual
      const requestTimeoutMs = getRequestTimeoutMs(env);
      const requestTimer = setTimeout(() => {
        seen.timedOut = true;
        interrupt();
        forceKillProcess(proc!);
        endStreamWithError(
          `Claude CLI request timed out after ${requestTimeoutMs / 1000} seconds`,
        );
      }, requestTimeoutMs);
      requestTimer.unref();
      stopRequestTimer = () => clearTimeout(requestTimer);

      // Track tool_use blocks for break-early decision at message_stop
      let sawToolCall = false;
      // Set up readline for line-by-line NDJSON parsing
      const rl = createInterface({
        input: proc.stdout!,
        crlfDelay: Infinity,
        terminal: false,
      });
      closeLines = () => rl.close();

      // Handle process error -- use endStreamWithError for guard
      proc.on("error", (err: Error) => {
        if (broken) return; // Break-early killed the process intentionally
        const stderr = getStderr();
        endStreamWithError(stderr || err.message);
      });

      // Handle subprocess close -- surface crashes with stderr and exit code
      proc.on("close", (code: number | null, signal: string | null) => {
        clearTimeout(inactivityTimer);
        // After any lines still waiting on the observer
        inOrder(() => onClose(code, signal));
      });
      const onClose = (code: number | null, signal: string | null) => {
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
      };

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
        // A settled request's terminal message must not change
        if (ended) return;

        // Reset inactivity timer on each line of output
        resetInactivityTimer();

        inOrder(() => handleLine(line));
      });
      const handleLine = async (line: string) => {
        if (broken) return; // A queued line after break-early

        const msg = parseLine(line);
        if (!msg) return;

        if (msg.type === "stream_event") {
          // Only forward top-level events to pi's event bridge.
          // Sub-agent events (parent_tool_use_id !== null) are internal to the CLI.
          const isTopLevel = !(msg as any).parent_tool_use_id;
          // Pi's observer sees the parsed CLI event before the bridge does
          if (isTopLevel && observe) {
            await observe(msg.event, model);
            if (broken || seen.cancelled || ended) return;
          }
          if (isTopLevel) {
            if (msg.event.type === "message_start") seen.messageStart = true;
            if (msg.event.type === "message_stop") seen.messageStop = true;
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
          seen.resultError = !!msg.is_error || msg.subtype.startsWith("error");
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
      };

      // Wait for readline to close (result received or process ended), then
      // for lines still queued behind the observer
      await new Promise<void>((resolve) => {
        rl.on("close", resolve);
      });
      await drained();

      // stdout can close before the exit code and stderr are in, with or
      // without partial output
      if (!ended && !resultSeen && !broken) {
        await new Promise<void>((resolve) =>
          proc!.exitCode !== null || proc!.signalCode != null
            ? resolve()
            : proc!.once("close", resolve),
        );
        await drained();
        if (resumeSessionId && proc.exitCode !== 0 && resumeLost(getStderr())) {
          seen.resumeLost = true;
          return true;
        }
      }

      // Push done event after readline closes (async). Pushing synchronously
      // inside handleMessageStop prevents pi from executing tools.
      // The terminal guard drops these once an error was already reported.
      // A known upstream failure or refused request is reported even after
      // partial content.
      if (relay.failure || relay.requestFailure) endStreamWithError("");

      // A thinking-only reply (no text, no tool call) leaves Pi with nothing
      // to act on; the empty-signature thinking block can't be replayed
      // either. End it as a real error so Pi can retry or report it.
      const blocks = output.content ?? [];
      const onlyEmptyThinking =
        blocks.length > 0 &&
        blocks.every(
          (b: any) =>
            b.type === "thinking" && !b.thinking && !b.thinkingSignature,
        );
      if (onlyEmptyThinking) {
        endWithError(
          { ...output, content: [] },
          "Claude returned an empty reply (thinking only, no text or tool call).",
        );
        return false;
      }

      // Success needs a complete supported streamed message, not a clean
      // exit or a nominal CLI result
      const incomplete = bridge.getIncompleteReason();
      if (incomplete) {
        endWithError(output, `Claude CLI protocol error: ${incomplete}.`);
        return false;
      }
      const replied = blocks.some((b: any) =>
        b.type === "text"
          ? !!b.text
          : b.type === "thinking"
            ? !!b.thinking || !!b.thinkingSignature
            : b.type === "toolCall",
      );
      if (!replied) {
        endWithError(
          output,
          "Claude returned an empty reply (no text, thinking or tool call).",
        );
        return false;
      }

      endWithDone(output);
    } catch (err: any) {
      seen.threw = true;
      endWithError(
        output ?? createAssistantOutput(model),
        err?.message || "Unexpected error in streamViaCli",
      );
      // Setup failed after the CLI started: nothing else will reap it
      if (proc) forceKillProcess(proc);
      closeLines?.();
    } finally {
      stopRequestTimer?.();
      clearTimeout(inactivityTimer);
      // Clean up abort listener
      if (options?.signal && abortHandler) {
        options.signal.removeEventListener("abort", abortHandler);
      }
      await relay?.stop();
      // Written once the CLI exits, without holding up the stream or a retry
      if (diagnostics) {
        const ended = relay;
        const reason = (
          exitCode: number | null,
          signal: string | null,
        ): TerminalReason => {
          if (seen.threw) return "error";
          if (seen.cancelled) return "cancelled";
          if (seen.timedOut) return "timed-out";
          if (seen.inactive) return "inactivity-timeout";
          if (seen.resumeLost) return "resume-lost";
          if (broken) return "tool-use";
          if (ended?.failure) return "upstream-error";
          if (resultSeen)
            return seen.resultError ? "result-error" : "completed";
          if (exitCode === 0)
            return seen.messageStart ? "exit-without-result" : "empty-exit";
          if (exitCode !== null) return "cli-exit-error";
          return signal ? "killed" : "error";
        };
        void diagnostics.finish(proc, (exitCode, signal) => ({
          requestId: randomUUID(),
          terminalReason: reason(exitCode, signal),
          sawMessageStart: seen.messageStart,
          sawMessageStop: seen.messageStop,
          sawResult: resultSeen,
          cancelled: seen.cancelled,
          timedOut: seen.timedOut,
          upstreamCount: ended?.upstreamCount ?? 0,
          rejectedCount: ended?.rejectedCount ?? 0,
        }));
      }
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
