#!/usr/bin/env node
/* global fetch */
// Minimal stand-in for `claude -p --input-format stream-json --output-format stream-json`.
// Reads one user message from stdin, forwards the prompt upstream (like the real CLI
// would), and replays the reply as stream-json events.

const args = process.argv.slice(2);
const modelIdx = args.indexOf("--model");
const model = modelIdx >= 0 ? args[modelIdx + 1] : "unknown";

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const event = (e) => emit({ type: "stream_event", event: e });

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  const nl = buffer.indexOf("\n");
  if (nl < 0) return;
  const userMessage = JSON.parse(buffer.slice(0, nl));
  buffer = "";
  run(userMessage).catch((err) => {
    process.stderr.write(String(err) + "\n");
    process.exit(1);
  });
});

async function run(userMessage) {
  const res = await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer fake-oauth-token",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [userMessage.message],
    }),
  });
  const reply = await res.json();
  if (!res.ok) {
    // The real CLI reports an API failure on stderr and exits non-zero.
    process.stderr.write(`API Error: ${res.status} ${JSON.stringify(reply)}\n`);
    process.exit(1);
  }

  // FAKE_CLAUDE_EXTRA_GENERATIONS=n: try n more generations, as the real CLI
  // would when it runs a tool and continues the turn.
  for (
    let i = 0;
    i < Number(process.env.FAKE_CLAUDE_EXTRA_GENERATIONS ?? 0);
    i++
  ) {
    await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 1024, messages: [] }),
    });
  }

  emit({ type: "system", subtype: "init", session_id: "fake-session" });
  event({ type: "message_start", message: { usage: reply.usage } });
  reply.content.forEach((block, index) => {
    if (block.type === "tool_use") {
      event({
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: block.id, name: block.name },
      });
      event({
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(block.input),
        },
      });
      event({ type: "content_block_stop", index });
      return;
    }
    event({
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    });
    event({
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text: block.text },
    });
    event({ type: "content_block_stop", index });
  });
  event({
    type: "message_delta",
    delta: { stop_reason: reply.stop_reason },
    usage: { output_tokens: reply.usage.output_tokens },
  });
  event({ type: "message_stop" });
  emit({ type: "result", subtype: "success", session_id: "fake-session" });
  process.exit(0);
}
