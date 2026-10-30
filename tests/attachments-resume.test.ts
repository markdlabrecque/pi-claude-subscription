import { describe, it, expect, afterEach, beforeEach } from "vitest";
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

// Resume's tool-result path: Pi calls the provider again with messages ending
// in a tool result and no new user message. The resumed CLI session already
// holds the earlier user turn and its image.
describe("resume tool-result path with an earlier image", () => {
  let upstream: FakeUpstream | undefined;
  let claude: FakeClaude | undefined;
  let home: string | undefined;
  const savedHome = process.env.HOME;
  const IMG = Buffer.from("not-really-a-png").toString("base64");

  beforeEach(async () => {
    upstream = await startFakeUpstream();
    claude = installFakeClaude(upstream.url);
    home = mkdtempSync(join(tmpdir(), "attachments-resume-home-"));
    process.env.HOME = home;
  });
  afterEach(async () => {
    claude?.restore();
    await upstream?.close();
    if (home) rmSync(home, { recursive: true, force: true });
    process.env.HOME = savedHome;
    claude = upstream = home = undefined;
  });

  it("sends the tool result text and not the old image", async () => {
    writeSession(home!, "pi-session-1", "{}\n");
    const stream = streamViaCli(
      model,
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Greet Pi" },
              { type: "image", data: IMG, mimeType: "image/png" },
            ],
          },
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "t1",
                name: "hello",
                arguments: { name: "Pi" },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "t1",
            toolName: "hello",
            content: [{ type: "text", text: "Hello, Pi! (tool result)" }],
            isError: false,
          },
        ],
      } as any,
      {
        sessionId: "pi-session-1",
        env: { PI_CLAUDE_SUBSCRIPTION_SESSION_MODE: "resume" },
      } as any,
    );
    for await (const _ of stream);

    expect(((await stream.result()) as any).stopReason).toBe("stop");
    expect(upstream!.requests).toHaveLength(1);
    const body = upstream!.requests[0].body as any;
    expect(body.fake_args).toContain("--resume");
    const sent = JSON.stringify(body.messages);
    expect(sent).toContain("Hello, Pi! (tool result)");
    expect(sent).not.toContain(IMG);
  });
});
