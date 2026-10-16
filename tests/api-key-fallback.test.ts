import { describe, it, expect, vi, beforeEach } from "vitest";

const streamSimpleAnthropic = vi.fn(() => "anthropic-stream");

vi.mock("@mariozechner/pi-ai", () => ({
  getEnvApiKey: vi.fn(() => "sk-env-key"),
  getModels: vi.fn(() => [
    { id: "claude-sonnet-4-5", api: "anthropic-messages" },
  ]),
  streamSimpleAnthropic: (...args: unknown[]) =>
    (streamSimpleAnthropic as any)(...args),
}));

import {
  API_KEY_FALLBACK_ENV,
  isApiKeyFallbackEnabled,
  streamViaAnthropic,
} from "../src/api-key-fallback.js";

describe("isApiKeyFallbackEnabled", () => {
  it("is read on every call, so flipping the setting switches paths", () => {
    expect(isApiKeyFallbackEnabled({})).toBe(false);
    expect(isApiKeyFallbackEnabled({ [API_KEY_FALLBACK_ENV]: "1" })).toBe(true);
    expect(isApiKeyFallbackEnabled({ [API_KEY_FALLBACK_ENV]: "true" })).toBe(
      true,
    );
    expect(isApiKeyFallbackEnabled({ [API_KEY_FALLBACK_ENV]: "0" })).toBe(
      false,
    );
    expect(isApiKeyFallbackEnabled({ [API_KEY_FALLBACK_ENV]: "" })).toBe(false);
  });
});

describe("streamViaAnthropic", () => {
  beforeEach(() => streamSimpleAnthropic.mockClear());

  it("sends the request through the Anthropic provider with the env API key", () => {
    const context = { messages: [] };
    const result = streamViaAnthropic(
      { id: "claude-sonnet-4-5", api: "pi-claude-subscription" } as any,
      context as any,
      { apiKey: "unused", sessionId: "s1" } as any,
    );

    expect(result).toBe("anthropic-stream");
    expect(streamSimpleAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ api: "anthropic-messages" }),
      context,
      expect.objectContaining({ apiKey: "sk-env-key", sessionId: "s1" }),
    );
  });

  it("rebuilds models missing from the catalog (e.g. the fable alias)", () => {
    streamViaAnthropic(
      { id: "fable", api: "pi-claude-subscription" } as any,
      {
        messages: [],
      } as any,
    );

    expect(streamSimpleAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "fable",
        api: "anthropic-messages",
        provider: "anthropic",
      }),
      expect.anything(),
      expect.anything(),
    );
  });
});
