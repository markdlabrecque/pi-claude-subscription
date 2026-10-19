#!/usr/bin/env node
// Acceptance-run spy: stands in for `claude` on PATH, runs the real CLI
// (ACCEPT_REAL_CLAUDE) and passes stdout through untouched. It appends one
// metadata line per CLI output message to ACCEPT_SPY_LOG (type only, never
// content), so the run can count tool executions by Claude Code itself: a CLI
// that ran a tool prints a `user` message carrying a `tool_result` block.
"use strict";

const { spawn } = require("node:child_process");
const { appendFileSync } = require("node:fs");

const child = spawn(process.env.ACCEPT_REAL_CLAUDE, process.argv.slice(2), {
  stdio: ["inherit", "pipe", "inherit"],
});

function note(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const blocks = Array.isArray(msg?.message?.content)
    ? msg.message.content
    : [];
  const kind =
    msg.type === "user" && blocks.some((b) => b.type === "tool_result")
      ? "tool_result"
      : msg.type;
  appendFileSync(
    process.env.ACCEPT_SPY_LOG,
    JSON.stringify({ pid: process.pid, kind }) + "\n",
  );
}

let buf = "";
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    note(buf.slice(0, i));
    buf = buf.slice(i + 1);
  }
});
child.on("close", (code) => process.exit(code ?? 1));
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => child.kill(sig));
}
