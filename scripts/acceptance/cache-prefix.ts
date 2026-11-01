/**
 * Real-CLI cache regression. Default: local SSE upstream and dummy login.
 * --live: three subscription requests using the existing Claude CLI login.
 * Prints only versions, usage and assertion outcomes, never request content.
 *
 * npx vite-node scripts/acceptance/cache-prefix.ts [--live]
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeContext, type AssistantMessage } from "@earendil-works/pi-ai";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { streamViaCli } from "../../src/provider.js";

const live = process.argv.includes("--live");
const catalogModel = anthropicProvider()
  .getModels()
  .find((m) => m.id === "claude-haiku-4-5");
assert(catalogModel, "Installed SDK must supply claude-haiku-4-5");
const model = { ...catalogModel, provider: "pi-claude-subscription" };
const pkg = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
);
console.log(
  JSON.stringify({
    pi: VERSION,
    extension: pkg.version,
    cli: execFileSync("claude", ["--version"], { encoding: "utf-8" }).trim(),
    model: model.id,
    live,
  }),
);

type Block = { type: string; text?: string; cache_control?: unknown };
type Payload = {
  system: unknown;
  tools: unknown;
  messages: { role: string; content: Block[] }[];
};
const captured: Payload[] = [];
let localRequests = 0;
const server = createServer(async (req, res) => {
  // Drain without retaining headers or request bytes.
  for await (const _chunk of req) {
    /* drain */
  }
  localRequests++;
  res.writeHead(200, { "content-type": "text/event-stream" });
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_local",
        type: "message",
        role: "assistant",
        model: model.id,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1000, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
  for (const event of events)
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
});
const scratch = mkdtempSync(join(tmpdir(), "pi-cache-check-"));
const messages: any[] = [
  {
    role: "user",
    content: live
      ? `Read this reference text and reply only OK.\n${"A stable cache prefix contains unchanged reference material.\n".repeat(1000)}`
      : "Say hello",
    timestamp: 1,
  },
];
// Cache-control markers move as history grows; their placement is not content.
const contentBytes = (blocks: Block[]) =>
  JSON.stringify(blocks.map(({ cache_control: _cache, ...block }) => block));
let previousUsage: AssistantMessage["usage"] | undefined;
try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (let i = 0; i < 3; i++) {
    const output = await streamViaCli(
      model,
      normalizeContext({ messages, systemPrompt: "Reply briefly." }),
      {
        onPayload: (payload) => {
          captured.push(structuredClone(payload) as Payload);
        },
        env: {
          ...(!live && {
            ANTHROPIC_BASE_URL: url,
            CLAUDE_CONFIG_DIR: scratch,
            CLAUDE_CODE_OAUTH_TOKEN: "offline-test-token",
          }),
          PI_CLAUDE_SUBSCRIPTION_TIMEOUT_MS: "60000",
          PI_CLAUDE_SUBSCRIPTION_SESSION_MODE: "replay",
        },
      },
    ).result();
    assert.equal(output.stopReason, "stop", "CLI request must complete");
    assert.equal(captured.length, i + 1, "one request per turn");
    const { input, cacheRead, cacheWrite } = output.usage;
    console.log(JSON.stringify({ turn: i + 1, input, cacheRead, cacheWrite }));
    if (i > 0) {
      const previous = captured[i - 1];
      const current = captured[i];
      // Boolean assertions keep request text out of failure output, too.
      assert(
        JSON.stringify(current.system) === JSON.stringify(previous.system),
        "system prompt changed",
      );
      assert(
        JSON.stringify(current.tools) === JSON.stringify(previous.tools),
        "tools changed",
      );
      assert(
        contentBytes(
          current.messages[0].content.slice(
            0,
            previous.messages[0].content.length,
          ),
        ) === contentBytes(previous.messages[0].content),
        "previous content is not an identical prefix",
      );
      if (live && previousUsage) {
        assert(
          cacheRead >= previousUsage.cacheRead + previousUsage.cacheWrite,
          "cache read fell short of the previous cached prefix",
        );
      }
    }
    previousUsage = output.usage;
    messages.push(output, { role: "user", content: "Again", timestamp: i + 2 });
  }
  if (!live) assert.equal(localRequests, 3);
  console.log(
    live
      ? "PASS: stable prefix and no cache shortfall"
      : "PASS: stable prefix through the real CLI, local responses only",
  );
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(scratch, { recursive: true, force: true });
}
