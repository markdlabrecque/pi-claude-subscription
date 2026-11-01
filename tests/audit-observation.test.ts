import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { normalizeContext } from "@earendil-works/pi-ai";
import { streamViaAnthropic } from "../src/api-key-fallback";
import { streamViaCli } from "../src/provider";
import { model } from "./harness";

const state = vi.hoisted(() => ({
  records: [] as Record<string, any>[],
  release: undefined as (() => void) | undefined,
}));
vi.mock("../src/audit", () => ({
  createAuditSink: () => ({
    append: async (record: Record<string, unknown>) => {
      state.records.push(structuredClone(record));
    },
  }),
}));
vi.mock("../src/relay", () => ({
  startRelay: () =>
    new Promise((resolve) => {
      state.release = () =>
        resolve({
          url: "http://127.0.0.1:1",
          stop: async () => {},
          upstreamCount: 0,
          rejectedCount: 0,
        });
    }),
}));
const secret = "SYNTHETIC-PRIVATE-API-ERROR-OUTPUT";
const context = () =>
  normalizeContext({
    messages: [{ role: "user", content: secret, timestamp: 1 }],
  });
const env = {
  PI_CLAUDE_SUBSCRIPTION_AUDIT: "1",
  ANTHROPIC_API_KEY: "synthetic-not-a-real-key",
};
beforeEach(() => {
  state.records.length = 0;
  state.release = undefined;
  vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_SESSION_MODE", "replay");
});
afterEach(() => vi.unstubAllEnvs());
async function terminal() {
  await vi.waitFor(() =>
    expect(
      state.records.filter((record) => record.event === "request_terminal"),
    ).toHaveLength(1),
  );
  expect(JSON.stringify(state.records)).not.toContain(secret);
  return state.records.find((record) => record.event === "request_terminal")!;
}

it.each(["abort", "fetch-failure"])(
  "preserves unknown API usage before a response for %s with the real SDK",
  async (mode) => {
    const controller = new AbortController();
    if (mode === "abort") controller.abort();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error(secret);
    });
    const stream = streamViaAnthropic(model, context(), {
      env,
      signal: controller.signal,
      fetch,
    });
    expect((await stream.result()).stopReason).toBe(
      mode === "abort" ? "aborted" : "error",
    );
    const end = await terminal();
    expect(end.usage).toEqual({
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      cacheWrite1h: null,
    });
    expect(end.estimatedCost.total).toBeNull();
    if (mode === "abort") expect(fetch).not.toHaveBeenCalled();
  },
);

it("records only API buckets actually observed, while forwarding the caller's stream hook", async () => {
  const hook = vi.fn();
  const events = [
    {
      type: "message_start",
      message: {
        id: "synthetic",
        type: "message",
        role: "assistant",
        model: model.id,
        content: [],
        usage: { input_tokens: 12 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: secret },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 4 },
    },
    { type: "message_stop" },
  ];
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(
        events
          .map(
            (event) =>
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          )
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  const stream = streamViaAnthropic(model, context(), {
    env,
    fetch,
    onProviderStreamEvent: hook,
  });
  expect((await stream.result()).stopReason).toBe("stop");
  expect(fetch).toHaveBeenCalledOnce();
  expect(hook).toHaveBeenCalledTimes(events.length);
  const end = await terminal();
  expect(end.usage).toEqual({
    input: 12,
    output: 4,
    cacheRead: null,
    cacheWrite: null,
    cacheWrite1h: null,
  });
  expect(end.estimatedCost.input).toBeGreaterThan(0);
  expect(end.estimatedCost.total).toBeNull();
});

it("preserves cancellation reason while relay startup is pending", async () => {
  const controller = new AbortController();
  const stream = streamViaCli(model, context(), {
    env,
    signal: controller.signal,
  });
  await vi.waitFor(() => expect(state.release).toBeTypeOf("function"));
  controller.abort();
  state.release!();
  expect((await stream.result()).stopReason).toBe("aborted");
  const end = await terminal();
  expect(end).toMatchObject({
    outcome: "cancelled",
    reason: "cancelled",
    attempts: [{ mode: "replay", reason: "cancelled" }],
  });
});
