import { describe, it, expect, afterEach, vi } from "vitest";
import { streamViaCli } from "../src/provider";
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

afterEach(async () => {
  claude?.restore();
  await upstream?.close();
  claude = upstream = undefined;
});

async function post(url: string, body: unknown) {
  return fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("fake upstream", () => {
  it("records each request and serves the scripted responses in order", async () => {
    upstream = await startFakeUpstream([
      "normal",
      "tool_call",
      "made_up_tool",
      "401",
      "429",
    ]);

    const normal = await (await post(upstream.url, { n: 1 })).json();
    const tool = await (await post(upstream.url, { n: 2 })).json();
    const madeUp = await (await post(upstream.url, { n: 3 })).json();
    const unauthorized = await post(upstream.url, { n: 4 });
    const limited = await post(upstream.url, { n: 5 });

    expect(normal.content[0]).toMatchObject({ type: "text" });
    expect(normal.stop_reason).toBe("end_turn");
    expect(tool.content[0]).toMatchObject({ type: "tool_use", name: "Read" });
    expect(tool.stop_reason).toBe("tool_use");
    expect(madeUp.content[0]).toMatchObject({
      type: "tool_use",
      name: "totally_made_up_tool",
    });
    expect(unauthorized.status).toBe(401);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("30");

    expect(upstream.requests.map((r) => r.body)).toEqual([
      { n: 1 },
      { n: 2 },
      { n: 3 },
      { n: 4 },
      { n: 5 },
    ]);
    expect(upstream.requests[0]).toMatchObject({
      method: "POST",
      path: "/v1/messages",
    });
  });

  it("hangs without answering and still shuts down", async () => {
    upstream = await startFakeUpstream(["hang"]);
    const aborted = post(upstream.url, {}).then(
      () => "answered",
      () => "dropped",
    );

    await vi.waitFor(() => expect(upstream!.requests).toHaveLength(1));
    await upstream.close();

    expect(await aborted).toBe("dropped");
  });
});

describe("plain turn through provider and fake claude", () => {
  it("delivers the stream events to Pi and sends one request upstream", async () => {
    upstream = await startFakeUpstream(["normal"]);
    claude = installFakeClaude(upstream.url);

    const stream = streamViaCli(model, {
      messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
    });
    const events: any[] = [];
    for await (const event of stream) events.push(event);
    const message: any = await stream.result();

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("start");
    expect(types).toContain("text_delta");
    expect(types.at(-1)).toBe("done");
    expect(message.stopReason).toBe("stop");
    expect(message.content).toEqual([
      { type: "text", text: "Hello from the fake upstream" },
    ]);

    expect(upstream.requests).toHaveLength(1);
    expect(JSON.stringify(upstream.requests[0].body)).toContain("Say hello");
  });
});
