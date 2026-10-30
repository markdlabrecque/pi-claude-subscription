import { afterEach, expect, it, vi } from "vitest";
import {
  normalizeContext,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index";
import { installFakeClaude, startFakeUpstream, NORMAL_TEXT } from "./harness";

afterEach(() => vi.unstubAllEnvs());

it("switches the registered callback to the real Anthropic SDK and back to CLI", async () => {
  const upstream = await startFakeUpstream();
  const claude = installFakeClaude(upstream.url);
  try {
    const registerProvider = vi.fn();
    extension({
      registerProvider,
      on: vi.fn(),
      getAllTools: () => [],
    } as unknown as ExtensionAPI);
    const [provider, config] = registerProvider.mock.calls[0];
    const model: Model<string> = {
      ...config.models[0],
      provider,
      api: provider,
      baseUrl: config.baseUrl,
    };
    const context = normalizeContext({
      messages: [{ role: "user", content: "Hello", timestamp: 1 }],
    });
    const controller = new AbortController();
    const payloads: unknown[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.headers.get("x-api-key")).toBe("sk-synthetic-test-key");
      expect(request.headers.get("x-test-header")).toBe("forwarded");
      const body = JSON.parse(await request.text());
      expect(body.max_tokens).toBe(123);
      expect(body.metadata.user_id).toBe("synthetic-user");
      expect(request.signal.aborted).toBe(false);
      const events = [
        {
          type: "message_start",
          message: {
            id: "msg_fake",
            type: "message",
            role: "assistant",
            model: model.id,
            content: [],
            usage: { input_tokens: 10, output_tokens: 0 },
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
          delta: { type: "text_delta", text: "SDK fallback" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 5 },
        },
        { type: "message_stop" },
      ];
      return new Response(
        events
          .map(
            (event) =>
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          )
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const options: SimpleStreamOptions = {
      apiKey: "unused",
      fetch,
      signal: controller.signal,
      maxTokens: 123,
      headers: { "x-test-header": "forwarded" },
      metadata: { user_id: "synthetic-user" },
      onPayload: (payload) => {
        payloads.push(payload);
      },
    };
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-synthetic-test-key");
    vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_API_KEY_FALLBACK", "1");
    const stream = config.streamSimple(model, context, options);
    for await (const _ of stream);
    expect(await stream.result()).toMatchObject({
      api: "anthropic-messages",
      provider: "anthropic",
      model: model.id,
      stopReason: "stop",
      content: [{ type: "text", text: "SDK fallback" }],
      usage: { input: 10, output: 5 },
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(payloads).toHaveLength(1);
    expect(upstream.requests).toHaveLength(0);

    vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_API_KEY_FALLBACK", "0");
    const cli = config.streamSimple(model, context);
    for await (const _ of cli);
    expect(await cli.result()).toMatchObject({
      provider,
      content: [{ type: "text", text: NORMAL_TEXT }],
    });
    expect(upstream.requests).toHaveLength(1);
    expect(fetch).toHaveBeenCalledOnce();

    vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_API_KEY_FALLBACK", "1");
    controller.abort();
    const aborted = config.streamSimple(model, context, options);
    for await (const _ of aborted);
    expect((await aborted.result()).stopReason).toBe("aborted");
    expect(upstream.requests).toHaveLength(1);
  } finally {
    claude.restore();
    await upstream.close();
  }
});
