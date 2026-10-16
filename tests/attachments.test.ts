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

  it("rejects an unsupported attachment with a clear error before any request", async () => {
    upstream = await startFakeUpstream();
    claude = installFakeClaude(upstream.url);

    const result = await run([
      { type: "text", text: "Summarise this" },
      { type: "file", name: "report.bin" },
    ]);

    expect(result.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining('"file" attachments are not supported'),
      },
    ]);
    expect(upstream.requests).toHaveLength(0);
  });
});
