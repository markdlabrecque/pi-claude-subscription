import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamViaCli } from "../src/provider";
import {
  startFakeUpstream,
  installFakeClaude,
  writeSession,
  type FakeUpstream,
  type FakeClaude,
  model,
} from "./harness";

let upstream: FakeUpstream | undefined;
let claude: FakeClaude | undefined;

afterEach(async () => {
  claude?.restore();
  await upstream?.close();
  claude = upstream = undefined;
});

async function run(content: unknown[]) {
  const stream = streamViaCli(model, {
    messages: [{ role: "user", content, timestamp: 1 }],
  });
  for await (const _ of stream);
  return (await stream.result()) as any;
}

describe("attachments", () => {
  it("passes an image through to the upstream request unchanged", async () => {
    upstream = await startFakeUpstream();
    claude = installFakeClaude(upstream.url);
    const data = Buffer.from("not-really-a-png").toString("base64");

    await run([
      { type: "text", text: "What colour?" },
      { type: "image", data, mimeType: "image/png" },
    ]);

    const sent = (upstream.requests[0].body as any).messages[0].content;
    expect(sent).toContainEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data },
    });
  });

  it("passes a document in the final message through to the upstream request", async () => {
    upstream = await startFakeUpstream();
    claude = installFakeClaude(upstream.url);
    const source = {
      type: "text",
      media_type: "text/plain",
      data: "The secret word is PELICAN-42.",
    };

    await run([
      { type: "text", text: "What is the secret word?" },
      { type: "document", source },
    ]);

    const sent = (upstream.requests[0].body as any).messages[0].content;
    expect(sent).toContainEqual({ type: "document", source });
  });

  it("sends a document from an earlier turn with the later request", async () => {
    upstream = await startFakeUpstream();
    claude = installFakeClaude(upstream.url);
    const source = {
      type: "text",
      media_type: "text/plain",
      data: "The secret word is PELICAN-42.",
    };

    const stream = streamViaCli(model, {
      messages: [
        { role: "user", content: [{ type: "document", source }], timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "text", text: "Noted." }],
          timestamp: 2,
        },
        { role: "user", content: "What is the secret word?", timestamp: 3 },
      ],
    });
    for await (const _ of stream);

    const sent = (upstream.requests[0].body as any).messages[0].content;
    expect(sent).toContainEqual({ type: "document", source });
  });

  it("rejects an unsupported attachment with a clear error before any request", async () => {
    upstream = await startFakeUpstream();
    claude = installFakeClaude(upstream.url);

    const stream = streamViaCli(model, {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Summarise this" },
            { type: "file", name: "report.bin" },
          ],
          timestamp: 1,
        },
      ],
    });
    const events: any[] = [];
    for await (const e of stream) events.push(e);
    const result: any = await stream.result();

    expect(events.map((e) => e.type)).toEqual(["error"]);
    expect(events[0].reason).toBe("error");
    expect(events[0].error).toBe(result);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(
      '"file" attachments are not supported',
    );
    expect(result.content).toEqual([]);
    expect(upstream.requests).toHaveLength(0);
  });
});

// Pi 1.x UserMessage / ToolResultMessage carry text and images only. The
// provider cannot carry an image outside the message it sends (replay drops
// earlier ones to placeholders), so it must refuse rather than omit.
const IMG = Buffer.from("not-really-a-png").toString("base64");
const image = { type: "image", data: IMG, mimeType: "image/png" };
const callMessage = {
  role: "assistant",
  content: [
    { type: "toolCall", id: "t1", name: "hello", arguments: { name: "Pi" } },
  ],
  timestamp: 2,
};
const imageResult = {
  role: "toolResult",
  toolCallId: "t1",
  toolName: "hello",
  content: [{ type: "text", text: "Seen it" }, image],
  isError: false,
  timestamp: 3,
};

/** Run a turn and expect a typed error with no upstream traffic. */
async function expectRejected(
  messages: unknown[],
  match: RegExp,
  options?: Record<string, unknown>,
) {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const stream = streamViaCli(model, { messages }, options as any);
    const events: any[] = [];
    for await (const e of stream) events.push(e);
    const result: any = await stream.result();

    expect(events.map((e) => e.type)).toEqual(["error"]);
    expect(events[0].reason).toBe("error");
    expect(events[0].error).toBe(result);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(match);
    expect(result.content).toEqual([]);
    expect(upstream!.requests).toHaveLength(0);
  } finally {
    warn.mockRestore();
  }
}

describe("attachments the provider cannot carry are rejected, not omitted", () => {
  beforeEach(async () => {
    upstream = await startFakeUpstream();
    claude = installFakeClaude(upstream.url);
  });

  it("rejects an image in an earlier user message (default replay)", async () => {
    await expectRejected(
      [
        {
          role: "user",
          content: [{ type: "text", text: "First" }, image],
          timestamp: 1,
        },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: "And now?", timestamp: 4 },
      ],
      /image/i,
    );
  });

  it("rejects an image-bearing tool result in a custom-tool follow-up", async () => {
    await expectRejected(
      [
        { role: "user", content: "Greet Pi", timestamp: 1 },
        callMessage,
        imageResult,
      ],
      /image/i,
    );
  });

  it("rejects an image-bearing tool result that precedes a new user turn", async () => {
    await expectRejected(
      [
        { role: "user", content: "Greet Pi", timestamp: 1 },
        callMessage,
        imageResult,
        { role: "assistant", content: [{ type: "text", text: "Done" }] },
        { role: "user", content: "Thanks", timestamp: 5 },
      ],
      /image/i,
    );
  });

  it("rejects an unknown block in an earlier user message and in a tool result", async () => {
    await expectRejected(
      [
        {
          role: "user",
          content: [{ type: "file", name: "a.bin" }],
          timestamp: 1,
        },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: "Next", timestamp: 3 },
      ],
      /"file" attachments are not supported/,
    );
    await expectRejected(
      [
        { role: "user", content: "Greet Pi", timestamp: 1 },
        callMessage,
        {
          ...imageResult,
          content: [{ type: "text", text: "x" }, { type: "audio" }],
        },
      ],
      /"audio" attachments are not supported/,
    );
  });

  it.each([
    ["no data", { type: "image", mimeType: "image/png" }],
    ["no media type", { type: "image", data: IMG }],
    ["non-string data", { type: "image", data: 42, mimeType: "image/png" }],
    ["empty data", { type: "image", data: "", mimeType: "image/png" }],
  ])(
    "rejects a malformed image in the final user message (%s)",
    async (_name, bad) => {
      await expectRejected(
        [{ role: "user", content: [{ type: "text", text: "Look" }, bad] }],
        /image/i,
      );
    },
  );

  it("rejects a malformed image in a tool result", async () => {
    await expectRejected(
      [
        { role: "user", content: "Greet Pi", timestamp: 1 },
        callMessage,
        {
          ...imageResult,
          content: [{ type: "image", mimeType: "image/png" }],
        },
      ],
      /image/i,
    );
  });

  it("still passes the final user image through byte-identically alongside an earlier document", async () => {
    const source = { type: "text", media_type: "text/plain", data: "DOC" };
    const stream = streamViaCli(model, {
      messages: [
        { role: "user", content: [{ type: "document", source }] },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: [{ type: "text", text: "Look" }, image] },
      ],
    });
    for await (const _ of stream);

    expect(upstream!.requests).toHaveLength(1);
    const sent = (upstream!.requests[0].body as any).messages[0].content;
    expect(sent).toContainEqual({ type: "document", source });
    expect(sent).toContainEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: IMG },
    });
  });
});

describe("attachments in resume mode", () => {
  let home: string | undefined;
  const savedHome = process.env.HOME;
  const options = {
    sessionId: "pi-session-1",
    env: { PI_CLAUDE_SUBSCRIPTION_SESSION_MODE: "resume" },
  };

  beforeEach(async () => {
    upstream = await startFakeUpstream();
    claude = installFakeClaude(upstream.url);
    home = mkdtempSync(join(tmpdir(), "attachments-home-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    process.env.HOME = savedHome;
    home = undefined;
  });

  const history = [
    { role: "user", content: [{ type: "text", text: "First" }, image] },
    callMessage,
    imageResult,
    { role: "assistant", content: [{ type: "text", text: "Done" }] },
  ];

  it("does not resend old images a valid resumed session already holds", async () => {
    writeSession(home!, "pi-session-1", "{}\n");
    const stream = streamViaCli(
      model,
      { messages: [...history, { role: "user", content: "Next question" }] },
      options as any,
    );
    for await (const _ of stream);

    expect(((await stream.result()) as any).stopReason).toBe("stop");
    expect(upstream!.requests).toHaveLength(1);
    const body = upstream!.requests[0].body as any;
    expect(body.fake_args).toContain("--resume");
    expect(JSON.stringify(body.messages)).toContain("Next question");
    expect(JSON.stringify(body.messages)).not.toContain(IMG);
  });

  it("rejects a new image-bearing tool result instead of sending a placeholder", async () => {
    writeSession(home!, "pi-session-1", "{}\n");
    await expectRejected(
      [history[0], callMessage, imageResult],
      /image/i,
      options,
    );
  });

  it("passes a new final user image to a resumed session", async () => {
    writeSession(home!, "pi-session-1", "{}\n");
    const stream = streamViaCli(
      model,
      {
        messages: [
          ...history,
          { role: "user", content: [{ type: "text", text: "Again" }, image] },
        ],
      },
      options as any,
    );
    for await (const _ of stream);

    const body = upstream!.requests[0].body as any;
    expect(body.fake_args).toContain("--resume");
    expect(body.messages[0].content).toContainEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: IMG },
    });
  });

  it("rejects, with no request, when a lost session falls back to replay with earlier images", async () => {
    // No session file: resume falls back to replay, which cannot carry them.
    await expectRejected(
      [...history, { role: "user", content: "Next question" }],
      /image/i,
      options,
    );
  });
});
