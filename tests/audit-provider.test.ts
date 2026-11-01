import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import childProcess from "node:child_process";
import * as processManager from "../src/process-manager";
import {
  normalizeContext,
  Type,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { streamViaCli } from "../src/provider";
import { writeMcpConfig } from "../src/mcp-config";
import {
  installFakeClaude,
  startFakeUpstream,
  model,
  NORMAL_TEXT,
  type FakeClaude,
  type FakeUpstream,
  type Scenario,
} from "./harness";

// The sink is the only new seam. Provider behavior, relay, CLI and Pi SDK are
// real. Capture records in memory so no test writes an installed extension dir.
const audit = vi.hoisted(() => ({ records: [] as Record<string, any>[] }));
vi.mock("../src/audit", () => ({
  createAuditSink: ({
    env = process.env,
  }: { env?: Record<string, string | undefined> } = {}) => ({
    append: async (record: Record<string, unknown>) => {
      if (["1", "true"].includes(env.PI_CLAUDE_SUBSCRIPTION_AUDIT ?? "")) {
        audit.records.push(structuredClone(record));
      }
    },
  }),
}));

let upstream: FakeUpstream | undefined;
let claude: FakeClaude | undefined;
let home: string;
const SECRET = "SYNTHETIC-PRIVATE-PROMPT-STDERR-ATTACHMENT";
const context = () => ({
  messages: [{ role: "user" as const, content: SECRET, timestamp: 1 }],
});

beforeEach(() => {
  audit.records.length = 0;
  home = mkdtempSync(join(tmpdir(), "audit-provider-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("TMPDIR", home);
  vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_AUDIT", "1");
  vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_DEBUG", "0");
  vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_SESSION_MODE", "replay");
  vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_API_KEY_FALLBACK", "0");
});
afterEach(async () => {
  claude?.restore();
  await upstream?.close();
  claude = upstream = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

async function setup(scenario: Scenario = "normal") {
  upstream = await startFakeUpstream([scenario]);
  claude = installFakeClaude(upstream.url);
}
async function settled(
  stream: AssistantMessageEventStream,
  expected = "error",
) {
  const result = await stream.result();
  expect(result.stopReason).toBe(expected);
  // Cleanup can finish after the user-visible terminal event.
  await vi.waitFor(() =>
    expect(
      audit.records.filter((r) => r.event === "request_terminal"),
    ).toHaveLength(1),
  );
  return result;
}
function terminal() {
  const starts = audit.records.filter((r) => r.event === "request_start");
  const ends = audit.records.filter((r) => r.event === "request_terminal");
  expect(starts).toHaveLength(1);
  expect(ends).toHaveLength(1);
  expect(starts[0].requestId).toEqual(expect.any(String));
  expect(starts[0].requestId.length).toBeGreaterThan(0);
  expect(ends[0].requestId).toBe(starts[0].requestId);
  expect(starts[0]).toMatchObject({
    route: "cli",
    model: model.id,
    sessionMode: "replay",
  });
  expect(Object.keys(starts[0].versions).sort()).toEqual([
    "cli",
    "extension",
    "pi",
  ]);
  for (const version of Object.values(starts[0].versions)) {
    expect(version === null || typeof version === "string").toBe(true);
  }
  const serialized = JSON.stringify(audit.records);
  for (const secret of [
    SECRET,
    NORMAL_TEXT,
    "fake-oauth-token",
    "fake-session",
    home,
  ])
    expect(serialized).not.toContain(secret);
  return ends[0];
}

// Terminal records use outcome + reason, usage with nullable observations,
// estimatedCost in API-equivalent dollars, relay counters, and cleanup states.
describe("CLI local audit lifecycle", () => {
  it("does not probe versions or account credentials for disabled audit requests", async () => {
    await setup();
    vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_AUDIT", "0");
    const probes = ["exec", "execSync", "execFile", "execFileSync"] as const;
    const spies = probes.map((name) => vi.spyOn(childProcess, name));
    const auth = vi.spyOn(processManager, "validateCliAuth");
    const result = await streamViaCli(model, context()).result();
    expect(result.stopReason).toBe("stop");
    expect(audit.records).toEqual([]);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(auth).not.toHaveBeenCalled();
  });
  it.each(["normal", "max_tokens", "tool_call"] as const)(
    "records successful %s without changing the provider result",
    async (scenario) => {
      await setup(scenario);
      const expected =
        scenario === "tool_call"
          ? "toolUse"
          : scenario === "max_tokens"
            ? "length"
            : "stop";
      const result = await settled(
        streamViaCli(
          model,
          { ...context(), tools: [{ name: "read" }] },
          {
            mcpConfigPath: writeMcpConfig([
              {
                name: "read",
                description: "read",
                inputSchema: { type: "object" },
              },
            ]),
          },
        ),
        expected,
      );
      expect(result.stopReason).toBe(expected);
      expect(terminal()).toMatchObject({
        route: "cli",
        outcome: "success",
        reason: expected,
        usage: {
          input: 10,
          output: 5,
          cacheRead: null,
          cacheWrite: null,
          cacheWrite1h: null,
        },
        relay: { upstreamCount: 1, rejectedCount: 0 },
        cleanup: {
          attempted: true,
          process: "confirmed",
          relay: "confirmed",
          sandbox: "confirmed",
        },
      });
    },
  );

  it("respects scoped opt-out and subsequent scoped opt-in, independent of ambient env", async () => {
    await setup();
    await streamViaCli(model, context(), {
      env: { PI_CLAUDE_SUBSCRIPTION_AUDIT: "0" },
    }).result();
    expect(audit.records).toEqual([]);
    vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_AUDIT", "0");
    await settled(
      streamViaCli(model, context(), {
        env: { PI_CLAUDE_SUBSCRIPTION_AUDIT: "true" },
      }),
      "stop",
    );
    expect(terminal().outcome).toBe("success");
    expect(upstream!.requests).toHaveLength(2);
  });

  it("records cancellation before spawn with unknown usage, not fabricated zeros or confirmed cleanup", async () => {
    await setup();
    const controller = new AbortController();
    controller.abort();
    const result = await settled(
      streamViaCli(model, context(), { signal: controller.signal }),
      "aborted",
    );
    expect(result.stopReason).toBe("aborted");
    expect(upstream!.requests).toHaveLength(0);
    expect(terminal()).toMatchObject({
      outcome: "cancelled",
      usage: {
        input: null,
        output: null,
        cacheRead: null,
        cacheWrite: null,
        cacheWrite1h: null,
      },
      estimatedCost: { total: null },
      cleanup: { attempted: false, process: "unknown", relay: "unknown" },
    });
  });

  it("records attachment rejection before any upstream call without attachment data", async () => {
    await setup();
    const result = await settled(
      streamViaCli(model, {
        messages: [
          {
            role: "user",
            content: [{ type: "file", name: SECRET, data: SECRET }],
            timestamp: 1,
          },
        ],
      }),
    );
    expect(result.stopReason).toBe("error");
    expect(upstream!.requests).toHaveLength(0);
    expect(terminal()).toMatchObject({
      outcome: "error",
      reason: "attachment_rejected",
      usage: { input: null, output: null },
    });
  });

  it("records repeated-tool rejection without arguments or tool results", async () => {
    await setup();
    const messages: any[] = context().messages;
    for (let i = 0; i < 3; i++) {
      messages.push({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: `call-${i}`,
            name: "read",
            arguments: { path: SECRET },
          },
        ],
        timestamp: 2 + i * 2,
      });
      messages.push({
        role: "toolResult",
        toolCallId: `call-${i}`,
        toolName: "read",
        content: [{ type: "text", text: SECRET }],
        isError: true,
        timestamp: 3 + i * 2,
      });
    }
    const result = await settled(streamViaCli(model, { messages }));
    expect(result.stopReason).toBe("error");
    expect(upstream!.requests).toHaveLength(0);
    expect(terminal()).toMatchObject({
      outcome: "error",
      reason: "repeated_tool_rejected",
    });
  });

  it.each([
    ["FAKE_CLAUDE_EMPTY_EXIT", "1", "protocol_error"],
    ["FAKE_CLAUDE_PARTIAL_FAIL", SECRET, "cli_exit"],
    ["FAKE_CLAUDE_RESULT_ERROR", SECRET, "result_error"],
  ])(
    "records %s and keeps partial observations",
    async (flag, value, reason) => {
      await setup();
      vi.stubEnv(flag, value);
      vi.stubEnv("FAKE_CLAUDE_PARTIAL_TEXT", SECRET);
      const result = await settled(streamViaCli(model, context()));
      expect(result.stopReason).toBe("error");
      const d = terminal();
      expect(d).toMatchObject({ outcome: "error", reason });
      expect(d.usage.input).toBe(flag === "FAKE_CLAUDE_EMPTY_EXIT" ? null : 10);
      expect(d.usage.output).toBe(flag === "FAKE_CLAUDE_EMPTY_EXIT" ? null : 5);
    },
  );

  it("records CLI spawn failure without raw errors", async () => {
    await setup();
    // No real CLI can be found, on any developer machine.
    vi.stubEnv("PATH", home);
    const result = await settled(streamViaCli(model, context()));
    expect(result.stopReason).toBe("error");
    expect(terminal()).toMatchObject({
      outcome: "error",
      reason: "spawn_error",
      usage: { input: null },
    });
  });

  it.each(["401", "429", "503"] as const)(
    "records safe HTTP %s details and existing relay rejection counts",
    async (status) => {
      await setup(status);
      const result = await settled(streamViaCli(model, context()));
      expect(result.stopReason).toBe("error");
      const d = terminal();
      expect(d).toMatchObject({
        outcome: "error",
        reason: "http_error",
        http: { status: Number(status) },
        relay: { upstreamCount: 1, rejectedCount: status === "503" ? 1 : 0 },
      });
      if (status === "429") expect(d.http.retryAfter).toBe("30");
      expect(upstream!.requests).toHaveLength(1);
      expect(JSON.stringify(d)).not.toMatch(
        /authorization|headers|authentication_error/,
      );
    },
  );

  it.each(["cancel", "timeout"])(
    "records %s during a request with measured partial usage",
    async (mode) => {
      await setup();
      vi.stubEnv("FAKE_CLAUDE_PARTIAL_HANG", "1");
      vi.stubEnv("FAKE_CLAUDE_PARTIAL_TEXT", SECRET);
      if (mode === "timeout")
        vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_TIMEOUT_MS", "500");
      const controller = new AbortController();
      const stream = streamViaCli(model, context(), {
        signal: controller.signal,
      });
      const events = (async () => {
        for await (const event of stream) {
          if (mode === "cancel" && event.type === "text_delta")
            controller.abort();
        }
      })();
      const result = await settled(
        stream,
        mode === "cancel" ? "aborted" : "error",
      );
      await events;
      expect(result.stopReason).toBe(mode === "cancel" ? "aborted" : "error");
      expect(terminal()).toMatchObject({
        outcome: mode === "cancel" ? "cancelled" : "error",
        reason: mode === "cancel" ? "cancelled" : "timeout",
        usage: { input: 10, output: 5 },
      });
    },
  );

  it("keeps resume fallback within one invocation, with two distinguishable attempts", async () => {
    await setup();
    vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_SESSION_MODE", "resume");
    await settled(
      streamViaCli(
        model,
        {
          messages: [
            ...context().messages,
            {
              role: "assistant",
              content: [{ type: "text", text: SECRET }],
              timestamp: 2,
            },
            { role: "user", content: SECRET, timestamp: 3 },
          ],
        },
        { sessionId: "missing-private-session-id" },
      ),
      "stop",
    );
    // No terminal() helper: this request intentionally uses resume mode.
    const starts = audit.records.filter((r) => r.event === "request_start");
    const ends = audit.records.filter((r) => r.event === "request_terminal");
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({
      requestId: starts[0].requestId,
      outcome: "success",
      attempts: [
        { mode: "resume", reason: "resume_missing" },
        { mode: "replay", reason: "stop" },
      ],
    });
    expect(upstream!.requests).toHaveLength(1);
    expect(JSON.stringify(audit.records)).not.toContain(
      "missing-private-session-id",
    );
  });

  it("records known cache buckets and API-equivalent estimated costs, including 1h writes", async () => {
    await setup();
    const event = (value: object) => ({ type: "stream_event", event: value });
    vi.stubEnv(
      "FAKE_CLAUDE_STREAM_SCRIPT",
      JSON.stringify([
        event({
          type: "message_start",
          message: {
            usage: {
              input_tokens: 10,
              output_tokens: 0,
              cache_read_input_tokens: 20,
              cache_creation_input_tokens: 12,
              cache_creation: {
                ephemeral_5m_input_tokens: 7,
                ephemeral_1h_input_tokens: 5,
              },
            },
          },
        }),
        event({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
        event({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: SECRET },
        }),
        event({ type: "content_block_stop", index: 0 }),
        event({
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 4 },
        }),
        event({ type: "message_stop" }),
        { type: "result", subtype: "success" },
      ]),
    );
    await settled(streamViaCli(model, context()), "stop");
    const d = terminal();
    expect(d.usage).toMatchObject({
      input: 10,
      output: 4,
      cacheRead: 20,
      cacheWrite: 12,
      cacheWrite1h: 5,
    });
    expect(d.estimatedCost.input).toBeCloseTo((10 * 3) / 1e6, 10);
    expect(d.estimatedCost.output).toBeCloseTo((4 * 15) / 1e6, 10);
    expect(d.estimatedCost.cacheRead).toBeCloseTo((20 * 0.3) / 1e6, 10);
    expect(d.estimatedCost.cacheWrite).toBeCloseTo(
      (7 * 3.75 + 5 * 6) / 1e6,
      10,
    );
    expect(d.estimatedCost.total).toBeCloseTo(
      (30 + 60 + 6 + 26.25 + 30) / 1e6,
      10,
    );
  });
});

async function registered() {
  const registerProvider = vi.fn();
  const { default: extension } = await import("../index");
  extension({
    registerProvider,
    on: vi.fn(),
    getAllTools: () => [],
  } as unknown as ExtensionAPI);
  expect(registerProvider).toHaveBeenCalledOnce();
  return registerProvider.mock.calls[0][1];
}

describe("registered provider audit coverage", () => {
  it("records tool inventory configuration failure before streamViaCli is reached", async () => {
    await setup();
    const config = await registered();
    const ctx = normalizeContext({
      ...context(),
      tools: [
        {
          name: "broken",
          description: SECRET,
          parameters: Type.Object({ path: Type.String() }),
        },
      ],
    });
    const mcp = await import("../src/mcp-config");
    vi.spyOn(mcp, "writeMcpConfig").mockImplementation(() => {
      throw new Error(SECRET);
    });
    const result = await settled(config.streamSimple(model, ctx, {}));
    expect(result.stopReason).toBe("error");
    expect(upstream!.requests).toHaveLength(0);
    expect(terminal()).toMatchObject({
      outcome: "error",
      reason: "tool_inventory_error",
    });
  });

  it.each(["onResponse", "onProviderStreamEvent"])(
    "records %s hook failure without the thrown text",
    async (hook) => {
      await setup();
      const config = await registered();
      const result = await settled(
        config.streamSimple(model, normalizeContext(context()), {
          [hook]: () => {
            throw new Error(SECRET);
          },
        }),
      );
      expect(result.stopReason).toBe("error");
      expect(terminal()).toMatchObject({
        outcome: "error",
        reason: "hook_error",
        hook,
      });
    },
  );
});
