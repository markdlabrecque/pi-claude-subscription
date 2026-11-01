import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamViaAnthropic } from "../src/api-key-fallback";
import { model } from "./harness";

const audit = vi.hoisted(() => ({ records: [] as Record<string, any>[] }));
vi.mock("../src/audit", () => ({
  createAuditSink: () => ({
    append: async (record: Record<string, unknown>) => {
      audit.records.push(structuredClone(record));
    },
  }),
}));
const SECRET = "SYNTHETIC-PRIVATE-HTTP-BODY-KEY";
beforeEach(() => {
  audit.records.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("API audit with the installed SDK HTTP transport", () => {
  it.each([401, 429, 503])(
    "observes HTTP %i without exposing response contents",
    async (status) => {
      const response = new Response(
        JSON.stringify({ error: { type: "api_error", message: SECRET } }),
        {
          status,
          headers: {
            "content-type": "application/json",
            "retry-after": "30",
            "x-private": SECRET,
          },
        },
      );
      const transport = vi.fn<typeof fetch>().mockResolvedValue(response);
      const onResponse = vi.fn();
      const result = await streamViaAnthropic(
        model,
        {
          messages: [{ role: "user", content: SECRET, timestamp: 1 }],
        } as any,
        {
          env: { PI_CLAUDE_SUBSCRIPTION_AUDIT: "1", ANTHROPIC_API_KEY: SECRET },
          fetch: transport,
          maxRetries: 0,
          onResponse,
        },
      ).result();
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain(SECRET);
      expect(transport).toHaveBeenCalledOnce();
      // The SDK does not deliver failed responses to the caller's hook.
      expect(onResponse).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(audit.records).toHaveLength(2));
      expect(audit.records[1]).toMatchObject({
        requestId: audit.records[0].requestId,
        outcome: "error",
        reason: "http_error",
        http: { status, retryAfter: "30" },
        usage: { input: null, output: null },
      });
      expect(JSON.stringify(audit.records)).not.toContain(SECRET);
    },
  );

  it("observes default fetch and clears a recovered failure before a caller hook fails", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("{}", { status: 503, headers: { "retry-after": "0" } }),
      )
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", transport);
    const onResponse = vi.fn(() => {
      throw new Error(SECRET);
    });
    const result = await streamViaAnthropic(
      model,
      {
        messages: [{ role: "user", content: "hello", timestamp: 1 }],
      } as any,
      {
        env: { PI_CLAUDE_SUBSCRIPTION_AUDIT: "1", ANTHROPIC_API_KEY: SECRET },
        maxRetries: 1,
        onResponse,
      },
    ).result();
    expect(result.stopReason).toBe("error");
    expect(transport).toHaveBeenCalledTimes(2);
    expect(onResponse).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(audit.records).toHaveLength(2));
    expect(audit.records[1]).toMatchObject({
      reason: "hook_error",
      hook: "onResponse",
    });
    expect(audit.records[1]).not.toHaveProperty("http");
    expect(JSON.stringify(audit.records)).not.toContain(SECRET);
  });
});
