import { describe, it, expect, afterEach, vi } from "vitest";
import { streamViaCli } from "../src/provider";
import { startRelay, type Relay } from "../src/relay";
import {
  startFakeUpstream,
  installFakeClaude,
  type FakeUpstream,
  type FakeClaude,
  type Scenario,
  model,
} from "./harness";

let upstream: FakeUpstream | undefined;
let claude: FakeClaude | undefined;
let relays: Relay[] = [];

afterEach(async () => {
  claude?.restore();
  delete process.env.FAKE_CLAUDE_EXTRA_GENERATIONS;
  delete process.env.FAKE_CLAUDE_NOT_LOGGED_IN;
  await Promise.all(relays.map((r) => r.stop()));
  await upstream?.close();
  claude = upstream = undefined;
  relays = [];
  vi.restoreAllMocks();
});

async function newRelay(log: (line: string) => void = () => {}) {
  upstream = await startFakeUpstream(["normal"]);
  const relay = await startRelay({ upstream: upstream.url, log });
  relays.push(relay);
  return relay;
}

const post = (url: string) =>
  fetch(`${url}/v1/messages?beta=true`, {
    method: "POST",
    headers: { authorization: "Bearer secret-token" },
    body: "{}",
  });

describe("relay", () => {
  it("forwards only the first Messages request, rejects the rest locally, and never logs auth", async () => {
    const lines: string[] = [];
    const relay = await newRelay((l) => lines.push(l));

    const first = await post(relay.url);
    const second = await post(relay.url);

    expect(first.status).toBe(200);
    expect(second.status).toBe(400);
    expect(upstream!.requests).toHaveLength(1);
    expect(upstream!.requests[0].headers.authorization).toBe(
      "Bearer secret-token",
    );
    expect(relay.upstreamCount).toBe(1);
    expect(relay.rejectedCount).toBe(1);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("upstream=1");
    expect(lines[1]).toMatch(/rejected.*upstream=1/);
    expect(lines.join("\n")).not.toContain("secret-token");
  });

  it("answers HEAD /api/hello locally, without spending the upstream request", async () => {
    const relay = await newRelay();

    const hello = await fetch(`${relay.url}/api/hello`, { method: "HEAD" });
    const first = await post(relay.url);

    expect(hello.ok).toBe(true);
    expect(first.status).toBe(200);
    expect(upstream!.requests.map((r) => r.path)).toEqual([
      "/v1/messages?beta=true",
    ]);
  });

  it("binds loopback on distinct random ports and frees the port on stop", async () => {
    const a = await newRelay();
    const b = await newRelay();

    expect(a.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(a.url).not.toBe(b.url);

    await a.stop();
    await expect(post(a.url)).rejects.toThrow();
  });
});

describe("relay in a Pi turn", () => {
  it("sends one request upstream when the CLI attempts a second generation, then closes the port", async () => {
    upstream = await startFakeUpstream(["normal"]);
    claude = installFakeClaude(upstream.url);
    process.env.FAKE_CLAUDE_EXTRA_GENERATIONS = "1";
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((l) => logs.push(String(l)));

    const stream = streamViaCli(model, {
      messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
    });
    for await (const _ of stream);
    const message: any = await stream.result();

    expect(message.content).toEqual([
      { type: "text", text: "Hello from the fake upstream" },
    ]);
    expect(upstream.requests).toHaveLength(1);
    expect(logs.some((l) => /rejected.*upstream=1/.test(l))).toBe(true);
    expect(logs.join("\n")).not.toContain("fake-oauth-token");
  });
});

describe("upstream errors in a Pi turn", () => {
  async function runTurn(scenario: Scenario) {
    upstream = await startFakeUpstream([scenario]);
    claude = installFakeClaude(upstream.url);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stream = streamViaCli(model, {
      messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
    });
    for await (const _ of stream);
    return (await stream.result()) as any;
  }

  it("401 ends with one error telling the user to run claude auth login, not a retryable one", async () => {
    const message = await runTurn("401");

    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("claude auth login");
    // Pi retries messages that look like rate limits or server errors.
    expect(message.errorMessage).not.toMatch(
      /rate.?limit|too many|\b(429|5\d\d)\b/i,
    );
    expect(upstream!.requests).toHaveLength(1);
  });

  it.each([
    ["503", "Claude API returned 503."],
    ["529", "Claude API returned 529 (overloaded)."],
  ] as const)(
    "%s names the status instead of the relay's one-request rejection",
    async (scenario, text) => {
      const message = await runTurn(scenario);

      expect(message.stopReason).toBe("error");
      expect(message.errorMessage).toBe(text);
      expect(message.errorMessage).not.toContain("only one");
    },
  );

  it("a CLI with no login ends with the same non-retryable auth error, without any request", async () => {
    process.env.FAKE_CLAUDE_NOT_LOGGED_IN = "1";

    const message = await runTurn("normal");

    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("claude auth login");
    expect(message.errorMessage).not.toMatch(/rate.?limit|too many|\b5\d\d\b/i);
    expect(upstream!.requests).toHaveLength(0);
  });

  it("429 ends with a rate-limit error that keeps retry-after, so Pi retries", async () => {
    const message = await runTurn("429");

    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toMatch(/rate limit/i);
    expect(message.errorMessage).toContain("30");
  });
});

describe("thinking-only reply in a Pi turn", () => {
  it("ends with an error event instead of an empty done, even when the CLI asks for a second request", async () => {
    upstream = await startFakeUpstream(["thinking_only"]);
    claude = installFakeClaude(upstream.url);
    process.env.FAKE_CLAUDE_EXTRA_GENERATIONS = "1";
    vi.spyOn(console, "error").mockImplementation(() => {});

    const stream = streamViaCli(model, {
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    });
    const types: string[] = [];
    for await (const e of stream) types.push((e as any).type);
    const message: any = await stream.result();

    expect(types[types.length - 1]).toBe("error");
    expect(types).not.toContain("done");
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toMatch(/empty reply/);
    expect(message.content).toEqual([]);
    expect(upstream.requests).toHaveLength(1);
  });
});
