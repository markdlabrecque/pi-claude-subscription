import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { streamViaAnthropic } from "../src/api-key-fallback";
import { model } from "./harness";

const fake = vi.hoisted(() => ({
  records: [] as Record<string, any>[],
  stream: vi.fn(),
}));
vi.mock("../src/audit", () => ({
  createAuditSink: ({
    env = process.env,
  }: { env?: Record<string, string | undefined> } = {}) => ({
    append: async (record: Record<string, unknown>) => {
      if (["1", "true"].includes(env.PI_CLAUDE_SUBSCRIPTION_AUDIT ?? ""))
        fake.records.push(structuredClone(record));
    },
  }),
}));
vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  getBuiltinModels: () => [],
}));
vi.mock("@earendil-works/pi-ai/compat", () => ({
  anthropicMessagesApi: () => ({
    streamSimple: (...args: unknown[]) => fake.stream(...args),
  }),
}));

const SECRET = "SYNTHETIC-API-KEY-PROMPT-OUTPUT-ERROR";
function message(stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    api: "anthropic-messages",
    provider: "anthropic",
    model: model.id,
    content: [{ type: "text", text: SECRET }],
    stopReason,
    timestamp: 1,
    usage: {
      input: 11,
      output: 3,
      cacheRead: 4,
      cacheWrite: 0,
      totalTokens: 18,
      cost: {
        input: 0.000033,
        output: 0.000045,
        cacheRead: 0.0000012,
        cacheWrite: 0,
        total: 0.0000792,
      },
    },
    ...(stopReason === "error" ? { errorMessage: SECRET } : {}),
  };
}
beforeEach(() => {
  fake.records.length = 0;
  fake.stream.mockReset();
  vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_AUDIT", "0");
  vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_DEBUG", "0");
});
afterEach(() => vi.unstubAllEnvs());

function request() {
  return streamViaAnthropic(
    model,
    { messages: [{ role: "user", content: SECRET, timestamp: 1 }] } as any,
    {
      env: { PI_CLAUDE_SUBSCRIPTION_AUDIT: "true", ANTHROPIC_API_KEY: SECRET },
    },
  );
}

describe("explicit API-key route local audit", () => {
  it.each(["stop", "error", "aborted"] as const)(
    "records API %s and preserves streamed events and partial usage",
    async (reason) => {
      fake.stream.mockImplementation((_model, _context, options) => {
        const upstream = createAssistantMessageEventStream();
        queueMicrotask(async () => {
          // Model the wire observation that accompanies this measured message,
          // rather than mistaking SDK-initialized usage defaults for evidence.
          await options.onProviderStreamEvent(
            {
              type: "message_start",
              message: {
                usage: {
                  input_tokens: 11,
                  output_tokens: 3,
                  cache_read_input_tokens: 4,
                  cache_creation_input_tokens: 0,
                },
              },
            },
            _model,
          );
          if (reason === "stop")
            upstream.push({ type: "done", reason, message: message(reason) });
          else upstream.push({ type: "error", reason, error: message(reason) });
          upstream.end();
        });
        return upstream;
      });
      const stream = request();
      const events = [];
      for await (const event of stream) events.push(event);
      expect(await stream.result()).toEqual(message(reason));
      expect(events).toHaveLength(1);
      expect(fake.stream.mock.calls[0][2].apiKey).toBe(SECRET);
      await vi.waitFor(() =>
        expect(
          fake.records.filter((r) => r.event === "request_terminal"),
        ).toHaveLength(1),
      );
      const starts = fake.records.filter((r) => r.event === "request_start");
      expect(starts).toHaveLength(1);
      const end = fake.records.find((r) => r.event === "request_terminal")!;
      expect(end).toMatchObject({
        requestId: starts[0].requestId,
        route: "api",
        model: model.id,
        outcome:
          reason === "stop"
            ? "success"
            : reason === "aborted"
              ? "cancelled"
              : "error",
        usage: {
          input: 11,
          output: 3,
          cacheRead: 4,
          cacheWrite: 0,
          cacheWrite1h: null,
        },
        estimatedCost: { total: 0.0000792 },
        cleanup: { attempted: false, process: "unknown", relay: "unknown" },
      });
      expect(JSON.stringify(fake.records)).not.toContain(SECRET);
    },
  );

  it("records synchronous SDK failure with unobserved usage null and still exposes the provider failure", async () => {
    fake.stream.mockImplementation(() => {
      throw new Error(SECRET);
    });
    // Audit must not transform a synchronous SDK exception into success.
    expect(() => request()).toThrow(SECRET);
    await vi.waitFor(() =>
      expect(
        fake.records.filter((r) => r.event === "request_terminal"),
      ).toHaveLength(1),
    );
    expect(
      fake.records.find((r) => r.event === "request_terminal"),
    ).toMatchObject({
      route: "api",
      outcome: "error",
      usage: { input: null, output: null },
      estimatedCost: { total: null },
    });
    expect(JSON.stringify(fake.records)).not.toContain(SECRET);
  });
});
