import { describe, it, expect, afterEach, vi } from "vitest";
import { streamViaCli } from "../src/provider";
import { startRelay, type Relay } from "../src/relay";
import {
  startFakeUpstream,
  installFakeClaude,
  type FakeUpstream,
  type FakeClaude,
} from "./harness";

const model: any = {
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  api: "anthropic-messages",
  provider: "pi-claude-subscription",
  reasoning: false,
  input: ["text"],
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  contextWindow: 200000,
  maxTokens: 8192,
};

let upstream: FakeUpstream | undefined;
let claude: FakeClaude | undefined;
let relays: Relay[] = [];

afterEach(async () => {
  claude?.restore();
  delete process.env.FAKE_CLAUDE_EXTRA_GENERATIONS;
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
