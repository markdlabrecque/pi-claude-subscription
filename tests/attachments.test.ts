import { describe, it, expect, afterEach } from "vitest";
import { streamViaCli } from "../src/provider";
import {
  startFakeUpstream,
  installFakeClaude,
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
