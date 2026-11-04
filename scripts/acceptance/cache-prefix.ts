/**
 * Real-CLI cache regression. Default: local SSE upstream and dummy login.
 * --live --approved-byte-budget --model <exact-haiku-id>: maintainer-run
 * subscription requests using the existing Claude CLI login.
 * --tool-result: text reply, tool call, then first tool result.
 * --tool-first: tool call on the first reply, then first tool result.
 * Prints only versions, usage and assertion outcomes, never request content.
 *
 * npx vite-node scripts/acceptance/cache-prefix.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getCurrentTools,
  normalizeContext,
  Type,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { streamViaCli } from "../../src/provider.js";
import { toMcpToolDefs, writeMcpConfig } from "../../src/mcp-config.js";
import {
  readCacheDiagnostic,
  type CacheDiagnostic,
} from "./cache-prefix-diagnostics.js";
import {
  CACHE_PREFIX_LIMITS,
  createCachePrefixBudget,
} from "./cache-prefix-budget.js";
import {
  assertNormalizedEnvironment,
  assertPreviousPrefix,
  type Payload,
} from "./cache-prefix-assertions.js";

const live = process.argv.includes("--live");
assert(
  !live || process.argv.includes("--approved-byte-budget"),
  "Live check requires --approved-byte-budget for the maintainer-approved revised limits. No live request was made.",
);
const modelIndex = process.argv.indexOf("--model");
const modelId =
  modelIndex === -1 ? "claude-haiku-4-5" : process.argv[modelIndex + 1];
assert(
  modelId && !modelId.startsWith("--"),
  "--model requires an exact model ID",
);
const toolFirst = process.argv.includes("--tool-first");
const toolResult = toolFirst || process.argv.includes("--tool-result");
const toolTurn = toolFirst ? 0 : 1;
const turnCount = toolFirst ? 2 : 3;
assert(
  !live || modelIndex !== -1,
  "Live check requires an explicit --model ID",
);
assert(!live || /haiku/i.test(modelId), "Only Haiku is approved for this run");
assert(!live || !toolResult, "Only text-only replay is approved for this run");
assert(
  !live || !process.env.ANTHROPIC_BASE_URL,
  "Live check requires the default subscription upstream",
);
const tools = toolResult
  ? [
      {
        name: "cache_probe",
        description: "Return a fixed cache acceptance marker",
        parameters: Type.Object({}),
      },
    ]
  : [];
const catalogModel = anthropicProvider()
  .getModels()
  .find((m) => m.id === modelId);
assert(
  catalogModel,
  "Selected model ID must exist in the installed SDK catalog",
);
const model = { ...catalogModel, provider: "pi-claude-subscription" };
async function main() {
  const started = Date.now();
  const budget = createCachePrefixBudget();
  const run = new AbortController();
  const deadline = setTimeout(
    () => run.abort("overall deadline"),
    CACHE_PREFIX_LIMITS.runMs,
  );
  const cancel = () => run.abort("maintainer cancellation");
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const previousDebug = process.env.PI_CLAUDE_SUBSCRIPTION_DEBUG;
  const previousError = console.error;
  const previousWarn = console.warn;
  const diagnostics: CacheDiagnostic[] = [];
  // Debug can include raw malformed CLI lines. Suppress all debug/warnings
  // except the allowlisted diagnostic fields; never save the original lines.
  console.error = (...args: unknown[]) => {
    const record = args.length === 1 ? readCacheDiagnostic(args[0]) : undefined;
    if (record) {
      diagnostics.push(record);
      console.log(
        JSON.stringify({ diagnosticTurn: diagnostics.length, ...record }),
      );
    }
  };
  console.warn = () => {};
  process.env.PI_CLAUDE_SUBSCRIPTION_DEBUG = "1";
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
    );
    console.log(
      JSON.stringify({
        pi: VERSION,
        extension: pkg.version,
        cli: execFileSync("claude", ["--version"], {
          encoding: "utf-8",
          timeout: 5000,
        }).trim(),
        date: new Date(started).toISOString(),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        revision: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf-8",
          timeout: 5000,
        }).trim(),
        dirty:
          execFileSync("git", ["status", "--porcelain"], {
            encoding: "utf-8",
            timeout: 5000,
          }).trim().length > 0,
        sessionMode: "replay",
        privateDirectory: true,
        privateTempRoot: "ephemeral run-owned directory",
        configDirectory: live
          ? process.env.CLAUDE_CONFIG_DIR
            ? "inherited"
            : "default"
          : "scratch",
        limits: CACHE_PREFIX_LIMITS,
        model: model.id,
        live,
        transition: toolResult
          ? toolFirst
            ? "tool-first"
            : "text-then-tool"
          : "text-only",
      }),
    );

    const captured: Payload[] = [];
    let localRequests = 0;
    const server = createServer(async (req, res) => {
      // Drain without retaining headers or request bytes.
      for await (const _chunk of req) {
        /* drain */
      }
      localRequests++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const callTool = toolResult && localRequests === toolTurn + 1;
      const events = [
        {
          type: "message_start",
          message: {
            id: "msg_local",
            type: "message",
            role: "assistant",
            model: model.id,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1000, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: callTool
            ? {
                type: "tool_use",
                id: "toolu_cache_probe",
                name: "mcp__custom-tools__cache_probe",
                input: {},
              }
            : { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: callTool
            ? { type: "input_json_delta", partial_json: "{}" }
            : { type: "text_delta", text: "Hello" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: {
            stop_reason: callTool ? "tool_use" : "end_turn",
            stop_sequence: null,
          },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ];
      for (const event of events)
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    const scratch = mkdtempSync(join(tmpdir(), "pi-cache-check-"));
    const callInstruction =
      "Call cache_probe exactly once now. Do not answer without calling it.";
    const messages: any[] = [
      {
        role: "user",
        content: live
          ? `Read this reference text and reply only OK.\n${"A stable cache prefix contains unchanged reference material.\n".repeat(1000)}`
          : "Say hello",
        timestamp: 1,
      },
    ];
    if (toolFirst) messages[0].content += `\n${callInstruction}`;
    let previousUsage: AssistantMessage["usage"] | undefined;
    const savedTemp = {
      TMPDIR: process.env.TMPDIR,
      TMP: process.env.TMP,
      TEMP: process.env.TEMP,
    };
    // Give this run its own temp root so cleanup checks cannot inspect or
    // delete another process's private directories. Auth config is unchanged.
    process.env.TMPDIR = scratch;
    if (process.platform === "win32")
      process.env.TEMP = process.env.TMP = scratch;
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      for (let i = 0; i < turnCount; i++) {
        assert(
          !run.signal.aborted,
          "run cancelled or overall deadline exceeded",
        );
        const turnStarted = Date.now();
        const context = normalizeContext({
          messages,
          tools,
          systemPrompt: "Reply briefly. Follow explicit tool-call requests.",
        });
        const output = await streamViaCli(model, context, {
          signal: AbortSignal.any([
            run.signal,
            AbortSignal.timeout(CACHE_PREFIX_LIMITS.requestMs),
          ]),
          ...(toolResult && {
            mcpConfigPath: writeMcpConfig(
              toMcpToolDefs(getCurrentTools(context.messages)),
            ),
          }),
          onPayload: (payload) => {
            try {
              const request = structuredClone(payload) as Payload;
              assert(
                !run.signal.aborted,
                "run cancelled or overall deadline exceeded",
              );
              assert(
                !live || (request as { model?: string }).model === model.id,
                "CLI changed the selected model ID; no substitution approved",
              );
              const assertions = assertNormalizedEnvironment(request);
              if (captured.length > 0)
                assertPreviousPrefix(captured[captured.length - 1], request);
              const reservation = budget.prepare(request);
              captured.push(request);
              console.log(
                JSON.stringify({ turn: i + 1, ...assertions, ...reservation }),
              );
              return request;
            } catch (error) {
              console.log(
                JSON.stringify({
                  turn: i + 1,
                  preflightPassed: false,
                  reason:
                    error instanceof assert.AssertionError
                      ? error.message
                      : "payload inspection failed",
                }),
              );
              throw error;
            }
          },
          onResponse: (response) => {
            console.log(
              JSON.stringify({ turn: i + 1, upstreamStatus: response.status }),
            );
            assert(
              response.status === 200,
              "upstream did not return HTTP 200; stop without retry",
            );
          },
          env: {
            ...(!live && {
              ANTHROPIC_BASE_URL: url,
              CLAUDE_CONFIG_DIR: scratch,
              CLAUDE_CODE_OAUTH_TOKEN: "offline-test-token",
            }),
            PI_CLAUDE_SUBSCRIPTION_AUDIT: "0",
            PI_CLAUDE_SUBSCRIPTION_TIMEOUT_MS: String(
              CACHE_PREFIX_LIMITS.requestMs,
            ),
            PI_CLAUDE_SUBSCRIPTION_SESSION_MODE: "replay",
          },
        }).result();
        // Diagnostics settle after process close and a bounded version probe.
        const diagnosticDeadline = Date.now() + 6000;
        while (
          diagnostics.length <= i &&
          Date.now() < diagnosticDeadline &&
          !run.signal.aborted
        ) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const diagnostic = diagnostics[i];
        assert(diagnostic, "request diagnostic did not settle");
        assert(
          diagnostic.environmentNormalized,
          "provider environmentNormalized is false",
        );
        assert(
          diagnostic.upstreamCount === 1 && diagnostic.rejectedCount === 0,
          "unexpected request or retry observed",
        );
        assert(
          diagnostic.completed && !diagnostic.cancelled && !diagnostic.timedOut,
          "request did not complete normally",
        );
        const expectTool = toolResult && i === toolTurn;
        // The cache check concerns the request carrying the result, not whether
        // its response is text or another tool call.
        assert(
          output.stopReason === "stop" || output.stopReason === "toolUse",
          "CLI request must complete successfully",
        );
        assert(
          !live || output.stopReason === "stop",
          "text-only run unexpectedly requested a tool",
        );
        if (expectTool) assert.equal(output.stopReason, "toolUse");
        assert.equal(captured.length, i + 1, "one request per turn");
        const {
          input,
          cacheRead,
          cacheWrite,
          output: outputTokens,
        } = output.usage;
        console.log(
          JSON.stringify({
            turn: i + 1,
            input,
            cacheRead,
            cacheWrite,
            output: outputTokens,
            durationMs: Date.now() - turnStarted,
          }),
        );
        assert(
          !live || cacheRead + cacheWrite > 0,
          "no cached prefix observed",
        );
        const usageTotals = budget.recordUsage(output.usage);
        console.log(JSON.stringify({ turn: i + 1, ...usageTotals }));
        if (i > 0) {
          const previous = captured[i - 1];
          const current = captured[i];
          // Boolean assertions keep request text out of failure output, too.
          if (toolResult && i === turnCount - 1) {
            assert(
              current.messages[0].content.some(
                (block) =>
                  block.type === "text" &&
                  block.text ===
                    '<turn role="tool" name="cache_probe">\nCACHE-PROBE-OK\n</turn>',
              ),
              "first tool result did not reach upstream intact",
            );
          }
          assertPreviousPrefix(previous, current);
          if (live && previousUsage) {
            assert(
              cacheRead >= previousUsage.cacheRead + previousUsage.cacheWrite,
              "cache read fell short of the previous cached prefix",
            );
          }
        }
        previousUsage = output.usage;
        messages.push(output);
        if (i === turnCount - 1) continue;
        if (expectTool) {
          const calls = output.content.filter(
            (block) => block.type === "toolCall",
          );
          assert.equal(calls.length, 1, "expected exactly one tool call");
          const call = calls[0];
          assert.equal(
            call.name,
            "cache_probe",
            "expected the offered Pi tool",
          );
          messages.push({
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text: "CACHE-PROBE-OK" }],
            isError: false,
            timestamp: i + 2,
          });
        } else {
          messages.push({
            role: "user",
            content: toolResult ? callInstruction : "Again",
            timestamp: i + 2,
          });
        }
      }
      if (!live) assert.equal(localRequests, turnCount);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const cleanupDeadline = Date.now() + 1500;
      const privateDirectories = () =>
        readdirSync(scratch).filter((name) =>
          /^pi-claude-subscription-[A-Za-z0-9]{6}$/.test(name),
        );
      while (privateDirectories().length > 0 && Date.now() < cleanupDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const privateDirectoryCleanup = privateDirectories().length === 0;
      try {
        rmSync(scratch, { recursive: true, force: true });
      } finally {
        for (const [key, value] of Object.entries(savedTemp)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      console.log(
        JSON.stringify({
          scratchCleanup: "confirmed",
          privateDirectoryCleanup,
        }),
      );
      assert(
        privateDirectoryCleanup,
        "private directory cleanup not confirmed before removing run scratch",
      );
    }
    assert(!run.signal.aborted, "run cancelled or overall deadline exceeded");
    console.log(
      live
        ? "PASS: stable prefix and no cache shortfall"
        : "PASS: stable prefix through the real CLI, local responses only",
    );
  } finally {
    budget.stop();
    clearTimeout(deadline);
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    console.error = previousError;
    console.warn = previousWarn;
    if (previousDebug === undefined)
      delete process.env.PI_CLAUDE_SUBSCRIPTION_DEBUG;
    else process.env.PI_CLAUDE_SUBSCRIPTION_DEBUG = previousDebug;
    console.log(
      JSON.stringify({
        durationMs: Date.now() - started,
        cancelled: run.signal.aborted,
      }),
    );
  }
}
await main().catch((error: unknown) => {
  // Never print a CLI error, transcript, payload or captured stderr.
  console.error(
    error instanceof assert.AssertionError
      ? `FAIL: ${error.message}`
      : "FAIL: execution error; raw error suppressed for privacy",
  );
  process.exitCode = 1;
});
