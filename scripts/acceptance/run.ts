/**
 * Acceptance runs against the real Claude CLI and subscription (opt-in; not
 * part of `npm test`). See README "Acceptance runs".
 *
 *   vite-node scripts/acceptance/run.ts turns [count]   50 tool-using turns
 *   vite-node scripts/acceptance/run.ts start <dir>     first half of a session
 *   vite-node scripts/acceptance/run.ts finish <dir>    finish it elsewhere
 *
 * It drives the provider's stream entry point the way Pi does, runs the Pi
 * tools itself, and reads the relay's own per-request log lines.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Keep the surrounding Claude Code session out of the child CLI.
for (const key of Object.keys(process.env)) {
  if (/^CLAUDE/.test(key) || key.startsWith("ANTHROPIC_")) {
    delete process.env[key];
  }
}

// Every temp file the run and the provider make lands here, removed at the end.
const scratch = mkdtempSync(join(tmpdir(), "pi-acceptance-"));
process.env.TMPDIR = scratch;

const credentials = join(homedir(), ".claude", ".credentials.json");
const inContainer = existsSync("/.dockerenv");
const spyLog = join(scratch, "spy.jsonl");

if (!inContainer) {
  // Host runs: a private CLI config dir, so the CLI's own state stays out of
  // ~/.claude. The login is a symlink to the existing credentials file.
  const configDir = join(scratch, "claude-config");
  mkdirSync(configDir);
  symlinkSync(credentials, join(configDir, ".credentials.json"));
  process.env.CLAUDE_CONFIG_DIR = configDir;
}

// The spy sits first on PATH and runs the real CLI.
const realClaude = execFileSync("which", ["claude"], {
  encoding: "utf-8",
}).trim();
const spyDir = join(scratch, "bin");
mkdirSync(spyDir);
writeFileSync(
  join(spyDir, "claude"),
  `#!/bin/sh\nexec "${process.execPath}" "${join(here, "claude-spy.cjs")}" "$@"\n`,
);
chmodSync(join(spyDir, "claude"), 0o755);
process.env.PATH = `${spyDir}${delimiter}${process.env.PATH}`;
process.env.ACCEPT_REAL_CLAUDE = realClaude;
process.env.ACCEPT_SPY_LOG = spyLog;
writeFileSync(spyLog, "");

// Imported after the environment is set up (static imports would run first).
const { streamViaCli } = await import("../../src/provider.js");
const { writeMcpConfig, removeMcpConfig } =
  await import("../../src/mcp-config.js");

const model: any = {
  id: "haiku",
  name: "Claude Haiku",
  api: "anthropic-messages",
  provider: "pi-claude-subscription",
  reasoning: false,
  input: ["text"],
  cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  contextWindow: 200000,
  maxTokens: 8192,
};

const toolDefs = [
  {
    name: "step",
    description: "Advance the counter. Returns what to call next.",
    inputSchema: {
      type: "object",
      properties: { n: { type: "number", description: "Step number" } },
      required: ["n"],
    },
  },
  {
    name: "lookup",
    description: "Look up a key. Returns a code.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string", description: "Key to look up" } },
      required: ["key"],
    },
  },
];

const spyEvents = () =>
  readFileSync(spyLog, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { pid: number; kind: string });

interface TurnRecord {
  stopReason: string;
  tools: string[];
  text: string;
  upstream: number;
  statuses: string[];
  rejected: number;
  cliToolExecutions: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  message: any;
}

/** One provider call, with the relay's log lines captured as they are written. */
async function turn(
  messages: any[],
  systemPrompt: string,
  mcpConfigPath: string,
): Promise<TurnRecord> {
  const lines: string[] = [];
  const saved = { error: console.error, warn: console.warn };
  console.error = console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  const spyBefore = spyEvents().length;
  const started = Date.now();
  let message: any;
  try {
    const stream = streamViaCli(model, { messages, systemPrompt }, {
      mcpConfigPath,
    } as any);
    for await (const _ of stream);
    message = await stream.result();
  } finally {
    console.error = saved.error;
    console.warn = saved.warn;
  }
  const upstreamLines = lines.filter((l) =>
    /relay POST \/v1\/messages -> upstream status=/.test(l),
  );
  return {
    stopReason: message.stopReason,
    tools: message.content
      .filter((c: any) => c.type === "toolCall")
      .map((c: any) => c.name),
    text: message.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join(""),
    upstream: upstreamLines.length,
    statuses: upstreamLines.map((l) => /status=(\d+)/.exec(l)![1]),
    rejected: lines.filter((l) => /rejected: one Messages request/.test(l))
      .length,
    cliToolExecutions: spyEvents()
      .slice(spyBefore)
      .filter((e) => e.kind === "tool_result").length,
    inputTokens: message.usage?.input ?? 0,
    outputTokens: message.usage?.output ?? 0,
    ms: Date.now() - started,
    message,
  };
}

function toolResult(call: any, text: string, timestamp: number) {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text }],
    isError: false,
    timestamp,
  };
}

const strip = ({ message: _m, ...rest }: TurnRecord) => rest;

// 1. Consecutive tool-using turns ------------------------------------------

async function runTurns(target: number) {
  const mcp = writeMcpConfig(toolDefs);
  try {
    const system =
      "Follow the tool instructions exactly. One tool call per reply.";
    const messages: any[] = [
      {
        role: "user",
        content:
          'Call step with n=1. After each result, make the call it says to make next. When it says DONE, reply "finished".',
        timestamp: Date.now(),
      },
    ];
    const records: TurnRecord[] = [];
    let calls = 0;

    while (records.length < target + 3) {
      const rec = await turn(messages, system, mcp);
      records.push(rec);
      console.log(
        `turn ${records.length}: stop=${rec.stopReason} tools=[${rec.tools}] upstream=${rec.upstream} rejected=${rec.rejected} cliToolExec=${rec.cliToolExecutions} ${rec.ms}ms`,
      );
      messages.push(rec.message);
      if (!rec.tools.length) break;
      for (const call of rec.message.content.filter(
        (c: any) => c.type === "toolCall",
      )) {
        calls++;
        const next =
          calls >= target
            ? "DONE"
            : calls % 5 === 0
              ? `Next: call lookup with key="k${calls}".`
              : `Next: call step with n=${calls + 1}.`;
        messages.push(toolResult(call, next, Date.now()));
      }
    }

    const toolTurns = records.filter((r) => r.tools.length);
    const last = records.at(-1)!;
    const summary = {
      mode: "turns",
      requestedToolTurns: target,
      toolTurns: toolTurns.length,
      allToolTurnsOneUpstream: toolTurns.every((r) => r.upstream === 1),
      totalUpstreamRequests: records.reduce((n, r) => n + r.upstream, 0),
      upstreamStatuses: [...new Set(records.flatMap((r) => r.statuses))],
      rejectedExtraRequests: records.reduce((n, r) => n + r.rejected, 0),
      claudeCodeToolExecutions: spyEvents().filter(
        (e) => e.kind === "tool_result",
      ).length,
      cliOutputMessagesSeen: spyEvents().length,
      toolsUsed: [...new Set(records.flatMap((r) => r.tools))],
      finalTurn: {
        stop: last.stopReason,
        text: last.text.slice(0, 80),
        upstream: last.upstream,
      },
      inputTokens: records.reduce((n, r) => n + r.inputTokens, 0),
      outputTokens: records.reduce((n, r) => n + r.outputTokens, 0),
      pass:
        toolTurns.length >= target &&
        toolTurns.every((r) => r.upstream === 1 && r.rejected === 0) &&
        spyEvents().every((e) => e.kind !== "tool_result") &&
        last.upstream === 1 &&
        !last.tools.length,
    };
    return { summary, records: records.map(strip) };
  } finally {
    removeMcpConfig(mcp);
  }
}

// 2. Cross-container replay --------------------------------------------------

/** File names only (never contents) under the CLI config dir. */
function cliFiles(): string[] {
  const root = join(homedir(), ".claude");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p.slice(root.length + 1));
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

const SYSTEM = "Follow the tool instructions exactly.";
const PROMPT =
  "Call lookup for key alpha, then lookup for key beta, then tell me both codes.";

async function runStart(dir: string) {
  const mcp = writeMcpConfig(toolDefs);
  try {
    const codes: Record<string, string> = {};
    const messages: any[] = [
      { role: "user", content: PROMPT, timestamp: Date.now() },
    ];
    const rec = await turn(messages, SYSTEM, mcp);
    messages.push(rec.message);
    for (const call of rec.message.content.filter(
      (c: any) => c.type === "toolCall",
    )) {
      const key = String(call.arguments.key);
      codes[key] =
        `${key.toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      messages.push(toolResult(call, codes[key], Date.now()));
    }
    writeFileSync(
      join(dir, "history.json"),
      JSON.stringify({ messages, codes }),
    );
    return {
      summary: {
        mode: "start",
        turn: strip(rec),
        keysIssued: Object.keys(codes),
        cliFilesAfter: cliFiles(),
        pass:
          rec.stopReason === "toolUse" &&
          rec.upstream === 1 &&
          rec.rejected === 0,
      },
    };
  } finally {
    removeMcpConfig(mcp);
  }
}

async function runFinish(dir: string) {
  const filesBefore = cliFiles();
  const mcp = writeMcpConfig(toolDefs);
  try {
    const { messages, codes } = JSON.parse(
      readFileSync(join(dir, "history.json"), "utf-8"),
    );
    const records: TurnRecord[] = [];
    for (let i = 0; i < 4; i++) {
      const rec = await turn(messages, SYSTEM, mcp);
      records.push(rec);
      messages.push(rec.message);
      if (!rec.tools.length) break;
      for (const call of rec.message.content.filter(
        (c: any) => c.type === "toolCall",
      )) {
        const key = String(call.arguments.key);
        codes[key] ??=
          `${key.toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
        messages.push(toolResult(call, codes[key], Date.now()));
      }
    }
    const final = records.at(-1)!;
    const alpha = (Object.entries(codes) as [string, string][]).find(([k]) =>
      /alpha/i.test(k),
    )?.[1];
    return {
      summary: {
        mode: "finish",
        turns: records.map(strip),
        cliFilesBeforeFirstRequest: filesBefore,
        cliFilesAfter: cliFiles(),
        // The alpha code exists only in the history carried over from container A.
        finalAnswerHasCodeFromA: !!alpha && final.text.includes(alpha),
        pass:
          !!alpha &&
          final.text.includes(alpha) &&
          records.every((r) => r.upstream === 1 && r.rejected === 0),
      },
    };
  } finally {
    removeMcpConfig(mcp);
  }
}

// Main ---------------------------------------------------------------------

const [mode, arg] = process.argv.slice(2);
let exitCode = 0;
try {
  const credBefore = inContainer ? undefined : statSync(credentials).mtimeMs;
  let result: any;
  if (mode === "turns") result = await runTurns(Number(arg ?? 50));
  else if (mode === "start") result = await runStart(arg);
  else if (mode === "finish") result = await runFinish(arg);
  else
    throw new Error("usage: run.ts turns [count] | start <dir> | finish <dir>");

  if (credBefore !== undefined) {
    result.summary.hostCredentialsFileUnchanged =
      statSync(credentials).mtimeMs === credBefore;
  }
  // The provider reaps the CLI and its temp dir up to a second after the result.
  await new Promise((r) => setTimeout(r, 2000));
  result.summary.strayCliProcesses = readdirSync("/proc").filter((pid) => {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf-8").includes(
        "claude-spy.cjs",
      );
    } catch {
      return false;
    }
  }).length;
  result.summary.leftoverTempEntries = readdirSync(scratch).filter((n) =>
    n.startsWith("pi-claude-subscription-"),
  );
  if (process.env.ACCEPT_VERBOSE && result.records) {
    console.log(JSON.stringify(result.records));
  }
  console.log("SUMMARY " + JSON.stringify(result.summary, null, 2));
  exitCode = result.summary.pass ? 0 : 1;
} catch (err) {
  console.error(err);
  exitCode = 2;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(exitCode);
