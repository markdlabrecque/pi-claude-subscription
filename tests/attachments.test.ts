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

// Pi 1.x UserMessage / ToolResultMessage carry text and images only. Images
// travel with their own turn; anything else, or a malformed image, must be
// refused rather than omitted.
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

  it("sends images from an earlier user message and a tool result, each after its own turn", async () => {
    const shot = Buffer.from("a-screenshot").toString("base64");
    const stream = streamViaCli(model, {
      messages: [
        { role: "user", content: [{ type: "text", text: "First" }, image] },
        callMessage,
        {
          ...imageResult,
          content: [
            { type: "text", text: "Seen it" },
            { type: "image", data: shot, mimeType: "image/jpeg" },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "Done" }] },
        { role: "user", content: "Thanks", timestamp: 5 },
      ],
    });
    for await (const _ of stream);

    expect(((await stream.result()) as any).stopReason).toBe("stop");
    expect(upstream!.requests).toHaveLength(1);
    const sent = (upstream!.requests[0].body as any).messages[0].content;
    expect(
      sent.map((b: any) =>
        b.type === "image"
          ? `${b.source.media_type} ${b.source.data}`
          : b.text.split("\n")[0],
      ),
    ).toEqual([
      '<turn role="user">',
      `image/png ${IMG}`,
      '<turn role="assistant">',
      '<turn role="tool" name="hello">',
      `image/jpeg ${shot}`,
      '<turn role="assistant">',
      '<turn role="user">',
    ]);
    expect(JSON.stringify(sent)).not.toContain("could not be included");
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

  it("passes a new image-bearing tool result to a resumed session", async () => {
    writeSession(home!, "pi-session-1", "{}\n");
    const stream = streamViaCli(
      model,
      {
        messages: [
          { role: "user", content: "Greet Pi" },
          callMessage,
          imageResult,
        ],
      },
      options as any,
    );
    for await (const _ of stream);

    const body = upstream!.requests[0].body as any;
    expect(body.fake_args).toContain("--resume");
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "TOOL RESULT (hello):\nSeen it" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: IMG },
      },
    ]);
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

  it("carries earlier images when a lost session falls back to replay", async () => {
    // No session file: resume falls back to replay, which resends them.
    const stream = streamViaCli(
      model,
      { messages: [...history, { role: "user", content: "Next question" }] },
      options as any,
    );
    for await (const _ of stream);

    expect(((await stream.result()) as any).stopReason).toBe("stop");
    expect(upstream!.requests).toHaveLength(1);
    const body = upstream!.requests[0].body as any;
    expect(body.fake_args).not.toContain("--resume");
    expect(
      body.messages[0].content.filter((b: any) => b.type === "image"),
    ).toHaveLength(2);
  });
});
