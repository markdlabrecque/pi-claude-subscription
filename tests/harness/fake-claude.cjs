#!/usr/bin/env node
/* global fetch */
// Minimal stand-in for `claude -p --input-format stream-json --output-format stream-json`.
// Reads one user message from stdin, forwards the prompt upstream (like the real CLI
// would), and replays the reply as stream-json events.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execSync, spawn } = require("node:child_process");
const readline = require("node:readline");

const args = process.argv.slice(2);
// Startup probes must never inspect a real login or make a request.
if (args[0] === "--version") {
  process.stdout.write("2.1.312 (fake Claude Code)\n");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(JSON.stringify({ loggedIn: true }) + "\n");
  process.exit(0);
}
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const model = flag("--model") ?? "unknown";

// Host config the real CLI would load, switched off by the same flags/env.
const BUILT_IN_TOOLS = ["Bash", "Read", "Edit", "Write", "Grep", "Glob"];
const DEFAULT_PROMPT = "You are Claude Code, Anthropic's official CLI.";
const home = process.env.HOME ?? os.homedir();
const claudeDir = path.join(home, ".claude");
const readIf = (file) =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
const settingsOn = flag("--setting-sources") !== "";
const claudeMdsOn =
  settingsOn && process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS !== "1";
const skillsOn = !args.includes("--disable-slash-commands");

function systemPrompt() {
  const replace =
    flag("--system-prompt") ?? readIf(flag("--system-prompt-file") ?? "");
  const append =
    flag("--append-system-prompt") ??
    readIf(flag("--append-system-prompt-file") ?? "");
  return [replace || DEFAULT_PROMPT, append].filter(Boolean).join("\n");
}

function skillListing() {
  const dir = path.join(claudeDir, "skills");
  if (!skillsOn || !fs.existsSync(dir)) return "";
  return fs
    .readdirSync(dir)
    .map((name) => readIf(path.join(dir, name, "SKILL.md")))
    .join("\n");
}

function hookOutput(event) {
  if (!settingsOn) return "";
  const settings = readIf(path.join(claudeDir, "settings.json"));
  const hooks = settings ? (JSON.parse(settings).hooks?.[event] ?? []) : [];
  return hooks
    .flatMap((h) => h.hooks)
    .map((h) => execSync(h.command, { encoding: "utf-8" }))
    .join("\n");
}

// Tools come from --mcp-config servers, queried like the real CLI does.
function mcpToolNames() {
  const file = flag("--mcp-config");
  if (!file) return Promise.resolve([]);
  const servers = JSON.parse(fs.readFileSync(file, "utf-8")).mcpServers ?? {};
  return Promise.all(
    Object.entries(servers).map(
      ([server, { command, args: serverArgs }]) =>
        new Promise((resolve) => {
          const child = spawn(command, serverArgs, {
            stdio: ["pipe", "pipe", "ignore"],
          });
          const rl = readline.createInterface({ input: child.stdout });
          rl.on("line", (line) => {
            const msg = JSON.parse(line);
            if (msg.id === 1) {
              child.stdin.write(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 2,
                  method: "tools/list",
                }) + "\n",
              );
            } else if (msg.id === 2) {
              child.kill();
              resolve(msg.result.tools.map((t) => `mcp__${server}__${t.name}`));
            }
          });
          child.stdin.write(
            JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) +
              "\n",
          );
        }),
    ),
  ).then((names) => names.flat());
}

// Session files, as the real CLI keeps them on disk: --session-id creates one,
// --resume needs a readable one. Otherwise it exits 1 with this message and
// sends no request (same for a missing and an unreadable file).
const sessionFile = (id) =>
  path.join(home, ".claude", "sessions", `${id}.jsonl`);
if (flag("--session-id")) {
  const file = sessionFile(flag("--session-id"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: "user" }) + "\n");
}
if (flag("--resume")) {
  const id = flag("--resume");
  let ok = true;
  try {
    for (const line of fs.readFileSync(sessionFile(id), "utf-8").split("\n")) {
      if (line) JSON.parse(line);
    }
  } catch {
    ok = false;
  }
  if (!ok) {
    process.stderr.write(`No conversation found with session ID: ${id}\n`);
    process.exit(1);
  }
}

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

// FAKE_CLAUDE_RECORD_FILE=path: also start a child that shares our stdio (like
// an MCP server would), and write the pids and base URL to that file so tests
// can check everything is gone afterwards.
function recordProcessTree() {
  const file = process.env.FAKE_CLAUDE_RECORD_FILE;
  if (!file) return;
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "inherit",
  });
  fs.writeFileSync(
    file,
    JSON.stringify({
      pids: [process.pid, child.pid],
      baseUrl: process.env.ANTHROPIC_BASE_URL,
    }),
  );
}

async function run(userMessage) {
  // FAKE_CLAUDE_NOT_LOGGED_IN=1: no stored login, so no request is sent. The
  // real CLI reports this as an error result and exits non-zero.
  if (process.env.FAKE_CLAUDE_NOT_LOGGED_IN) {
    emit({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Not logged in \u00b7 Please run /login",
    });
    process.exit(1);
  }
  // FAKE_CLAUDE_EMPTY_EXIT=1: exit 0 silently, with no events and no request.
  if (process.env.FAKE_CLAUDE_EMPTY_EXIT) process.exit(0);
  recordProcessTree();
  const context = [
    claudeMdsOn && readIf(path.join(claudeDir, "CLAUDE.md")),
    hookOutput("UserPromptSubmit"),
  ].filter(Boolean);
  const content = userMessage.message.content;
  const blocks =
    typeof content === "string" ? [{ type: "text", text: content }] : content;
  const tools = [
    ...(flag("--tools") === "" ? [] : BUILT_IN_TOOLS),
    ...(await mcpToolNames()),
  ];
  const request = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer fake-oauth-token",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: [systemPrompt(), skillListing()].filter(Boolean).join("\n"),
      tools: tools.map((name) => ({ name })),
      // Where the CLI ran, so tests can check the directory is cleaned up.
      fake_cwd: process.cwd(),
      // The CLI arguments, so tests can check for session flags.
      fake_args: args,
      // The environment the CLI was given: test markers and base URL by value,
      // forbidden credential/provider variables by name only (never values).
      fake_env: {
        markers: Object.fromEntries(
          Object.entries(process.env).filter(([k]) => k.startsWith("PI_TEST_")),
        ),
        baseUrl: process.env.ANTHROPIC_BASE_URL,
        nonessentialTraffic:
          process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
        disableClaudeMds: process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS,
        disableAutoMemory: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY,
        forbiddenPresent: Object.keys(process.env).filter(
          (k) =>
            k === "ANTHROPIC_API_KEY" ||
            k === "ANTHROPIC_AUTH_TOKEN" ||
            k.startsWith("CLAUDE_CODE_USE_"),
        ),
      },
      messages: [
        {
          ...userMessage.message,
          content: [
            ...context.map((text) => ({ type: "text", text })),
            ...blocks,
          ],
        },
      ],
    }),
  };
  const url = `${process.env.ANTHROPIC_BASE_URL}/v1/messages`;
  let res = await fetch(url, request);
  // Like the real CLI, retry a server error once; the relay rejects the retry.
  if (res.status >= 500) res = await fetch(url, request);
  let reply;
  try {
    reply = await res.json();
  } catch {
    // A body cut off mid-stream: retry once, then report the failure on stderr.
    res = await fetch(url, request);
    try {
      reply = await res.json();
    } catch {
      process.stderr.write(`API Error: connection closed early\n`);
      process.exit(1);
    }
  }
  if (process.env.FAKE_CLAUDE_FAIL_AFTER_REQUEST) {
    // Fail with this stderr text once the request is sent (a mid-turn crash).
    process.stderr.write(process.env.FAKE_CLAUDE_FAIL_AFTER_REQUEST + "\n");
    process.exit(1);
  }
  if (process.env.FAKE_CLAUDE_PARTIAL_FAIL) {
    // Stream some text, then crash with this stderr text (partial output).
    emit({ type: "system", subtype: "init", session_id: "fake-session" });
    event({ type: "message_start", message: { usage: reply.usage } });
    event({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    event({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: process.env.FAKE_CLAUDE_PARTIAL_TEXT },
    });
    process.stderr.write(process.env.FAKE_CLAUDE_PARTIAL_FAIL + "\n");
    process.exit(1);
  }
  if (process.env.FAKE_CLAUDE_RESULT_ERROR) {
    // Report an error result, after partial text when FAKE_CLAUDE_PARTIAL_TEXT is set.
    emit({ type: "system", subtype: "init", session_id: "fake-session" });
    if (process.env.FAKE_CLAUDE_PARTIAL_TEXT) {
      event({ type: "message_start", message: { usage: reply.usage } });
      event({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      event({
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: process.env.FAKE_CLAUDE_PARTIAL_TEXT,
        },
      });
    }
    emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: [process.env.FAKE_CLAUDE_RESULT_ERROR],
    });
    process.exit(1);
  }
  if (!res.ok) {
    // The real CLI reports an API failure on stderr and exits non-zero.
    process.stderr.write(`API Error: ${res.status} ${JSON.stringify(reply)}\n`);
    process.exit(1);
  }

  // FAKE_CLAUDE_EXTRA_GENERATIONS=n: try n more generations, as the real CLI
  // would when it runs a tool and continues the turn.
  // FAKE_CLAUDE_CONTINUE_ON_MAX_TOKENS=1: try one continuation after a
  // max_tokens stop (unconfirmed on the real CLI; see the ADR).
  const extra =
    Number(process.env.FAKE_CLAUDE_EXTRA_GENERATIONS ?? 0) +
    (process.env.FAKE_CLAUDE_CONTINUE_ON_MAX_TOKENS &&
    reply.stop_reason === "max_tokens"
      ? 1
      : 0);
  for (let i = 0; i < extra; i++) {
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
    if (block.type === "thinking") {
      event({
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "" },
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
