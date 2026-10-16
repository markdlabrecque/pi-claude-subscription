import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamViaCli } from "../src/provider";
import { SESSION_MODE_ENV } from "../src/session-mode";
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

const messages = [
  { role: "user", content: "Read notes.txt please", timestamp: 1 },
  {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "t1",
        name: "read",
        arguments: { path: "notes.txt" },
      },
    ],
  },
  {
    role: "toolResult",
    toolCallId: "t1",
    toolName: "read",
    content: [{ type: "text", text: "NOTES-FILE-CONTENTS" }],
  },
  { role: "assistant", content: [{ type: "text", text: "It says hello." }] },
  { role: "user", content: "Now summarise it", timestamp: 2 },
];

let upstream: FakeUpstream | undefined;
let claude: FakeClaude | undefined;
let home: string | undefined;
const savedHome = process.env.HOME;

afterEach(async () => {
  claude?.restore();
  await upstream?.close();
  if (home) rmSync(home, { recursive: true, force: true });
  process.env.HOME = savedHome;
  delete process.env[SESSION_MODE_ENV];
  claude = upstream = home = undefined;
});

/** Run the last turn of the session in a fresh HOME with no session files. */
async function lastTurn(mode?: string) {
  upstream = await startFakeUpstream();
  claude = installFakeClaude(upstream.url);
  home = mkdtempSync(join(tmpdir(), "session-mode-home-"));
  process.env.HOME = home;
  if (mode) process.env[SESSION_MODE_ENV] = mode;
  const stream = streamViaCli(model, { systemPrompt: "PI-PROMPT", messages }, {
    sessionId: "pi-session-1",
  } as any);
  for await (const _ of stream);
  await stream.result();
  expect(upstream.requests).toHaveLength(1);
  return upstream.requests[0].body as any;
}

describe("session mode", () => {
  it("replay is the default: full history, tool calls and results reach upstream with no CLI session state", async () => {
    const body = await lastTurn();

    expect(body.fake_args).not.toContain("--resume");
    expect(body.fake_args).not.toContain("--session-id");
    expect(readdirSync(home!)).toEqual([]);

    expect(body.messages).toHaveLength(1);
    const sent = JSON.stringify(body.messages[0].content);
    for (const part of [
      "Read notes.txt please",
      "notes.txt",
      "NOTES-FILE-CONTENTS",
      "It says hello.",
      "Now summarise it",
    ]) {
      expect(sent).toContain(part);
    }
    // Oldest first
    expect(sent.indexOf("Read notes.txt")).toBeLessThan(
      sent.indexOf("Now summarise"),
    );
  });

  it("switching to resume is a config change: only the new turn is sent, with --resume", async () => {
    const body = await lastTurn("resume");

    expect(body.fake_args).toContain("--resume");
    expect(JSON.stringify(body.messages)).toContain("Now summarise it");
    expect(JSON.stringify(body.messages)).not.toContain("NOTES-FILE-CONTENTS");
  });
});
