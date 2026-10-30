import { afterEach, expect, it, vi } from "vitest";
import {
  normalizeContext,
  type Model,
  type AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  installFakeClaude,
  startFakeUpstream,
  NORMAL_TEXT,
  type FakeClaude,
  type FakeUpstream,
} from "./harness";

let claude: FakeClaude | undefined;
let upstream: FakeUpstream | undefined;
afterEach(async () => {
  claude?.restore();
  await upstream?.close();
  vi.unstubAllEnvs();
});

it("streams a real normalized text request through the registered callback", async () => {
  vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_API_KEY_FALLBACK", "0");
  upstream = await startFakeUpstream();
  claude = installFakeClaude(upstream.url);
  const registerProvider = vi.fn();
  const { default: extension } = await import("../index");
  extension({
    registerProvider,
    on: vi.fn(),
    getAllTools: () => [],
  } as unknown as ExtensionAPI);
  expect(registerProvider).toHaveBeenCalledOnce();
  const [id, config] = registerProvider.mock.calls[0];
  expect(id).toBe("pi-claude-subscription");
  const model: Model<string> = {
    ...config.models[0],
    provider: id,
    api: config.api,
    baseUrl: config.baseUrl,
  };
  const context = normalizeContext({
    messages: [{ role: "user", content: "Hello", timestamp: 1 }],
  });
  const stream = config.streamSimple(model, context);
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  const result = await stream.result();
  expect(
    events
      .filter((e) => e.type === "text_delta")
      .map((e) => e.delta)
      .join(""),
  ).toBe(NORMAL_TEXT);
  expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  expect(result).toMatchObject({
    role: "assistant",
    provider: id,
    api: id,
    model: model.id,
    stopReason: "stop",
    content: [{ type: "text", text: NORMAL_TEXT }],
    usage: { input: 10, output: 5, totalTokens: 15 },
  });
  expect(result.timestamp).toBeGreaterThan(0);
  expect(result.usage.cost.total).toBeGreaterThan(0);
  expect(upstream.requests).toHaveLength(1);
});
