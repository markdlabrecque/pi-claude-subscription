/**
 * Live acceptance runs against the real Claude CLI and subscription (#79).
 * Opt-in and local only: never part of `npm test` and never run in CI. See
 * README "Acceptance runs" and docs/live-acceptance.md.
 *
 *   vite-node scripts/acceptance/run.ts <scenario> --approval <file>
 *     --model <exact id> --records <dir>
 *     [--phase start|finish --shared <dir>]   fresh-container-replay only
 *     [--host darwin|linux]                   required inside a container
 *
 * Scenarios: tool-turns-50, compaction-continuation, fresh-container-replay.
 *
 * Nothing is spawned and no credential is touched until the process is
 * outside CI and the approval file covers this host, model and scenario. The
 * approved scope, limits and stop conditions are written to the run record
 * before the first request, and the run stops when a limit is reached.
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
import { randomUUID } from "node:crypto";
import { homedir, release, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Approval,
  type RunRecordInput,
  type ScenarioId,
  SCENARIO_FIXTURES,
  TOOL_TURN_TARGET,
  assertApproved,
  assertLocalExecution,
  buildRunRecord,
  evaluateScenario,
  isScenarioId,
  resolveRequestedModels,
} from "./evidence.js";
import { getSessionMode } from "../../src/session-mode.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const inContainer =
  existsSync("/.dockerenv") || existsSync("/run/.containerenv");

const USAGE = `usage: run.ts <tool-turns-50|compaction-continuation|fresh-container-replay> --approval <file> --model <exact id> --records <dir> [--phase start|finish --shared <dir>] [--host darwin|linux]`;

// Gate: no side effects before this passes ----------------------------------

interface Args {
  scenario: ScenarioId;
  approval: string;
  model: string;
  records: string;
  phase?: "start" | "finish";
  shared?: string;
  host?: string;
}

function parseArgs(argv: string[]): Args {
  const [scenario, ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    const key = flag?.replace(/^--/, "");
    if (
      !flag?.startsWith("--") ||
      !["approval", "model", "records", "phase", "shared", "host"].includes(
        key,
      ) ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new Error(USAGE);
    }
    flags[key] = value;
  }
  if (
    !scenario ||
    !isScenarioId(scenario) ||
    !flags.approval ||
    !flags.model ||
    !flags.records
  ) {
    throw new Error(USAGE);
  }
  const replay = scenario === "fresh-container-replay";
  if (
    replay !== (flags.phase !== undefined) ||
    replay !== (flags.shared !== undefined) ||
    (replay && !["start", "finish"].includes(flags.phase))
  ) {
    throw new Error(USAGE);
  }
  return { ...flags, scenario } as Args;
}

/** A container is always Linux; the matrix cell is the machine running it. */
function hostPlatform(given?: string): string {
  if (!inContainer) {
    if (given && given !== process.platform) {
      throw new Error(
        `--host ${given} does not match this host (${process.platform})`,
      );
    }
    return process.platform;
  }
  if (!given) {
    throw new Error(
      "Inside a container, pass --host with the platform of the machine running it",
    );
  }
  return given;
}

function gate() {
  const args = parseArgs(process.argv.slice(2));
  assertLocalExecution(process.env);
  const host = hostPlatform(args.host);
  const approval = assertApproved(
    JSON.parse(readFileSync(args.approval, "utf-8")) as Approval,
    { host, model: args.model, scenario: args.scenario },
  );
  return { args, host, approval };
}

const { args, host, approval } = (() => {
  try {
    return gate();
  } catch (err) {
    console.error(`REFUSED ${(err as Error).message}`);
    return process.exit(2);
  }
})();
console.log(
  `approved by ${approval.ref}: limits ${JSON.stringify(approval.limits)}, stop conditions ${JSON.stringify(approval.stopConditions)}`,
);

// Exact model id, checked against what the provider registers -----------------

const { getBuiltinModels } =
  await import("@earendil-works/pi-ai/providers/all");
const { filterLatestPerFamily } = await import("../../src/model-filter.js");
const catalog = filterLatestPerFamily([...getBuiltinModels("anthropic")]);
const [resolution] = resolveRequestedModels(
  [args.model],
  catalog.map((m) => m.id),
);
if (resolution.status === "untested") {
  console.log(
    `UNTESTED ${args.model}: not among the installed Pi models (${catalog.map((m) => m.id).join(", ")}). No request sent; no other model substituted.`,
  );
  process.exit(3);
}
const model = {
  ...catalog.find((m) => m.id === resolution.resolvedId)!,
  provider: "pi-claude-subscription",
};

// Environment ----------------------------------------------------------------

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
const credentialsFile = existsSync(credentials);
const spyLog = join(scratch, "spy.jsonl");

if (!inContainer && credentialsFile) {
  // Host runs: a private CLI config dir, so the CLI's own state stays out of
  // ~/.claude. The login is a symlink to the existing credentials file. Hosts
  // that keep the login elsewhere (such as the macOS keychain) use the
  // default config dir.
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

const packageVersion = (path: string) =>
  (
    JSON.parse(readFileSync(join(repoRoot, path), "utf-8")) as {
      version: string;
    }
  ).version;
const cliVersion = /\d+\.\d+\.\d+\S*/.exec(
  execFileSync(realClaude, ["--version"], { encoding: "utf-8" }),
)?.[0];
const versions = {
  node: process.versions.node,
  pi: packageVersion("node_modules/@earendil-works/pi-ai/package.json"),
  piCodingAgent: packageVersion(
    "node_modules/@earendil-works/pi-coding-agent/package.json",
  ),
  claudeCli: cliVersion ?? "",
  extension: packageVersion("package.json"),
};
// The harness calls the CLI path directly; API fallback is never involved.
const config = { sessionMode: getSessionMode(process.env), apiFallback: false };

// Imported after the environment is set up (static imports would run first).
const { streamViaCli } = await import("../../src/provider.js");
const { writeMcpConfig } = await import("../../src/mcp-config.js");
const { normalizeContext } = await import("@earendil-works/pi-ai");
const { convertToLlm, generateSummaryWithUsage } =
  await import("@earendil-works/pi-coding-agent");

// Budget and stop conditions ---------------------------------------------------

class StopRun extends Error {}

const controller = new AbortController();
let stopReason: string | undefined;
let cancelTrigger: string | undefined;
function stop(reason: string, trigger?: string) {
  stopReason ??= reason;
  if (trigger && !cancelTrigger) {
    cancelTrigger = trigger;
    controller.abort();
  }
}
process.on("SIGINT", () => stop("interrupted by SIGINT", "SIGINT"));
const deadline = setTimeout(
  () => stop("limit reached: maxSeconds", "maxSeconds"),
  approval.limits.maxSeconds * 1000,
);

const usage = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
const tokensUsed = () =>
  usage.inputTokens +
  usage.outputTokens +
  usage.cacheReadTokens +
  usage.cacheWriteTokens;

function beforeRequest() {
  if (usage.requests >= approval.limits.maxRequests) {
    stop("limit reached: maxRequests");
  } else if (tokensUsed() >= approval.limits.maxTokens) {
    stop("limit reached: maxTokens");
  }
  if (stopReason) throw new StopRun(stopReason);
}

interface Measured {
  upstream: number;
  statuses: string[];
  rejected: number;
}

function afterRequest(
  measured: Measured,
  spent?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  },
) {
  usage.requests += measured.upstream;
  usage.inputTokens += spent?.input ?? 0;
  usage.outputTokens += spent?.output ?? 0;
  usage.cacheReadTokens += spent?.cacheRead ?? 0;
  usage.cacheWriteTokens += spent?.cacheWrite ?? 0;
  const status = measured.statuses.find((s) => s !== "200");
  if (status) stop(`upstream status ${status}`);
  else if (measured.rejected) stop("relay rejected an extra request");
  if (stopReason) throw new StopRun(stopReason);
}

// Provider calls -----------------------------------------------------------------

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

/** Run one provider call with the relay's log lines captured as they are written. */
async function captureRelay<T>(
  fn: () => Promise<T>,
): Promise<Measured & { value?: T; error?: unknown }> {
  const lines: string[] = [];
  const saved = {
    error: console.error,
    warn: console.warn,
    debug: process.env.PI_CLAUDE_SUBSCRIPTION_DEBUG,
  };
  console.error = console.warn = (...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  };
  // The relay writes its per-request lines only under the debug flag (#96).
  // They are captured here in memory, never printed or saved raw.
  process.env.PI_CLAUDE_SUBSCRIPTION_DEBUG = "1";
  let value: T | undefined;
  let error: unknown;
  try {
    value = await fn();
  } catch (err) {
    error = err;
  } finally {
    console.error = saved.error;
    console.warn = saved.warn;
    if (saved.debug === undefined) {
      delete process.env.PI_CLAUDE_SUBSCRIPTION_DEBUG;
    } else process.env.PI_CLAUDE_SUBSCRIPTION_DEBUG = saved.debug;
  }
  const upstreamLines = lines.filter((l) =>
    /relay POST \/v1\/messages -> upstream status=/.test(l),
  );
  return {
    value,
    error,
    upstream: upstreamLines.length,
    statuses: upstreamLines.map((l) => /status=(\d+)/.exec(l)![1]),
    rejected: lines.filter((l) => /rejected: one Messages request/.test(l))
      .length,
  };
}

interface TurnRecord extends Measured {
  stopReason: string;
  tools: string[];
  text: string;
  cliToolExecutions: number;
  ms: number;
  message: any;
}

/** One provider call, budgeted. The provider removes each MCP config file. */
async function turn(
  messages: any[],
  systemPrompt: string,
): Promise<TurnRecord> {
  beforeRequest();
  const spyBefore = spyEvents().length;
  const started = Date.now();
  const measured = await captureRelay(async () => {
    const stream = streamViaCli(
      model,
      normalizeContext({ messages, systemPrompt }),
      {
        mcpConfigPath: writeMcpConfig(toolDefs),
        signal: controller.signal,
      } as any,
    );
    for await (const _ of stream);
    return stream.result();
  });
  if (measured.error) {
    usage.requests += measured.upstream;
    throw measured.error;
  }
  const message: any = measured.value;
  const rec: TurnRecord = {
    upstream: measured.upstream,
    statuses: measured.statuses,
    rejected: measured.rejected,
    stopReason: message.stopReason,
    tools: message.content
      .filter((c: any) => c.type === "toolCall")
      .map((c: any) => c.name),
    text: message.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join(""),
    cliToolExecutions: spyEvents()
      .slice(spyBefore)
      .filter((e) => e.kind === "tool_result").length,
    ms: Date.now() - started,
    message,
  };
  console.log(
    `turn: stop=${rec.stopReason} tools=[${rec.tools}] upstream=${rec.upstream} rejected=${rec.rejected} cliToolExec=${rec.cliToolExecutions} ${rec.ms}ms`,
  );
  afterRequest(rec, message.usage);
  return rec;
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

const toolCalls = (rec: TurnRecord) =>
  rec.message.content.filter((c: any) => c.type === "toolCall");

const newCode = (key: string) =>
  `${key.toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

/** Answer lookup calls with one random code per key until a text reply. */
async function lookupLoop(
  messages: any[],
  codes: Record<string, string>,
  maxTurns: number,
  onTurn: (rec: TurnRecord) => void,
) {
  for (let i = 0; i < maxTurns; i++) {
    const rec = await turn(messages, SYSTEM);
    onTurn(rec);
    messages.push(rec.message);
    if (!rec.tools.length) return;
    for (const call of toolCalls(rec)) {
      const key = String(call.arguments.key);
      codes[key] ??= newCode(key);
      messages.push(toolResult(call, codes[key], Date.now()));
    }
  }
}

const SYSTEM = "Follow the tool instructions exactly.";
const PROMPT =
  "Call lookup for key alpha, then lookup for key beta, then tell me both codes.";

// Scenario state, kept current so a stopped run is still evaluated ------------

let observation: object = {};

// 1. tool-turns-50 -------------------------------------------------------------

async function runTurns() {
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
  const observe = () => {
    const toolTurns = records.filter((r) => r.tools.length);
    const last = records.at(-1);
    const final = last && !last.tools.length ? last : undefined;
    observation = {
      toolTurns: toolTurns.length,
      allToolTurnsOneUpstream: toolTurns.every((r) => r.upstream === 1),
      rejectedExtraRequests: records.reduce((n, r) => n + r.rejected, 0),
      claudeCodeToolExecutions: spyEvents().filter(
        (e) => e.kind === "tool_result",
      ).length,
      finalText: final?.text ?? "",
      finalTurnUpstream: final?.upstream,
    };
  };
  let calls = 0;
  while (records.length < TOOL_TURN_TARGET + 3) {
    const rec = await turn(messages, system);
    records.push(rec);
    observe();
    messages.push(rec.message);
    if (!rec.tools.length) break;
    for (const call of toolCalls(rec)) {
      calls++;
      const next =
        calls >= TOOL_TURN_TARGET
          ? "DONE"
          : calls % 5 === 0
            ? `Next: call lookup with key="k${calls}".`
            : `Next: call step with n=${calls + 1}.`;
      messages.push(toolResult(call, next, Date.now()));
    }
  }
}

// 2. compaction-continuation ---------------------------------------------------

const RECALL_PROMPT =
  "Using only the conversation summary, without calling any tool, reply with the codes lookup returned for alpha and beta.";

async function runCompaction() {
  const codes: Record<string, string> = {};
  const messages: any[] = [
    { role: "user", content: PROMPT, timestamp: Date.now() },
  ];
  const turns: TurnRecord[] = [];
  const observe = (compacted: boolean, finalText: string) => {
    observation = {
      seededFacts: Object.values(codes),
      finalText,
      compacted,
      allOneUpstream: turns.every((r) => r.upstream === 1),
      rejectedExtraRequests: turns.reduce((n, r) => n + r.rejected, 0),
    };
  };
  await lookupLoop(messages, codes, 4, (rec) => {
    turns.push(rec);
    observe(false, "");
  });

  // Pi's own compaction: summarize, then drop the summarized messages.
  beforeRequest();
  const summary = await captureRelay(() =>
    generateSummaryWithUsage(
      messages,
      model as any,
      undefined,
      "unused",
      undefined,
      controller.signal,
      undefined,
      undefined,
      undefined,
      ((m: any, context: any, options: any) =>
        streamViaCli(m, context, {
          ...options,
          mcpConfigPath: writeMcpConfig(toolDefs),
        })) as any,
      undefined,
      { enabled: false, maxRetries: 0, baseDelayMs: 0 },
    ),
  );
  turns.push({ ...summary, ms: 0 } as TurnRecord);
  console.log(
    `compaction: upstream=${summary.upstream} rejected=${summary.rejected} summarized=${!summary.error}`,
  );
  afterRequest(summary, summary.value?.usage);
  if (summary.error) {
    throw new StopRun("compaction summary request failed");
  }
  const kept = convertToLlm([
    {
      role: "compactionSummary",
      summary: summary.value!.text,
      tokensBefore: 0,
      timestamp: Date.now(),
    },
    { role: "user", content: RECALL_PROMPT, timestamp: Date.now() },
  ] as any);
  const compacted =
    summary.value!.text.trim().length > 0 &&
    !kept.some((m: any) => m.role === "toolResult");
  observe(compacted, "");

  const rec = await turn(kept, SYSTEM);
  turns.push(rec);
  observe(compacted, rec.tools.length ? "" : rec.text);
}

// 3. fresh-container-replay ----------------------------------------------------

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

interface ReplayHandoff {
  runId: string;
  startedAt: string;
  approvalRef: string;
  host: string;
  model: string;
  durationMs: number;
  usage: typeof usage;
  startOneUpstream: boolean;
  startRejected: number;
  messages: any[];
  codes: Record<string, string>;
}

const handoffPath = () => join(args.shared!, "history.json");

/** Container A: one request; Pi issues the codes and saves the history. */
async function runReplayStart(): Promise<boolean> {
  const codes: Record<string, string> = {};
  const messages: any[] = [
    { role: "user", content: PROMPT, timestamp: Date.now() },
  ];
  const rec = await turn(messages, SYSTEM);
  messages.push(rec.message);
  for (const call of toolCalls(rec)) {
    const key = String(call.arguments.key);
    codes[key] ??= newCode(key);
    messages.push(toolResult(call, codes[key], Date.now()));
  }
  const handoff: ReplayHandoff = {
    runId,
    startedAt,
    approvalRef: approval.ref,
    host,
    model: model.id,
    durationMs: Date.now() - t0,
    usage,
    startOneUpstream: rec.upstream === 1,
    startRejected: rec.rejected,
    messages,
    codes,
  };
  writeFileSync(handoffPath(), JSON.stringify(handoff));
  return rec.stopReason === "toolUse" && rec.upstream === 1 && !rec.rejected;
}

/** Container B, fresh: replay the carried history and recall the alpha code. */
async function runReplayFinish(handoff: ReplayHandoff) {
  const filesBefore = cliFiles();
  const freshCliState =
    inContainer && filesBefore.every((f) => f === ".credentials.json");
  const { messages, codes } = handoff;
  const alpha = Object.entries(codes).find(([k]) => /alpha/i.test(k))?.[1];
  const turns: TurnRecord[] = [];
  const observe = () => {
    const last = turns.at(-1);
    observation = {
      codeFromFirstContainer: alpha ?? "",
      finalText: last && !last.tools.length ? last.text : "",
      allOneUpstream:
        handoff.startOneUpstream && turns.every((r) => r.upstream === 1),
      rejectedExtraRequests:
        handoff.startRejected + turns.reduce((n, r) => n + r.rejected, 0),
      freshCliState,
    };
  };
  observe();
  await lookupLoop(messages, codes, 4, (rec) => {
    turns.push(rec);
    observe();
  });
}

// Records ------------------------------------------------------------------------

let runId = `${args.scenario}-${host}-${model.id}-${randomUUID().slice(0, 8)}`;
let startedAt = new Date().toISOString();
const t0 = Date.now();
let carriedMs = 0;
let handoff: ReplayHandoff | undefined;

if (args.phase === "finish") {
  try {
    handoff = JSON.parse(readFileSync(handoffPath(), "utf-8")) as ReplayHandoff;
  } catch {
    handoff = undefined;
  }
  if (
    !handoff ||
    handoff.approvalRef !== approval.ref ||
    handoff.host !== host ||
    handoff.model !== model.id
  ) {
    console.error(
      "REFUSED no start phase history for this approval, host and model",
    );
    rmSync(scratch, { recursive: true, force: true });
    process.exit(2);
  }
  ({ runId, startedAt } = handoff);
  carriedMs = handoff.durationMs;
  Object.assign(usage, handoff.usage);
}

const recordPath = join(args.records, `${runId}.json`);

function writeRecord(fields: Partial<RunRecordInput>) {
  const record = buildRunRecord({
    runId,
    campaignId: approval.ref,
    startedAt,
    host: {
      platform: host,
      arch: process.arch,
      release: release(),
      container: inContainer,
    },
    versions,
    model: { requested: args.model, resolvedId: model.id },
    scenario: {
      id: args.scenario,
      fixtureId: SCENARIO_FIXTURES[args.scenario],
    },
    config,
    approvalRef: approval.ref,
    approval,
    outcome: "failed",
    durationMs: carriedMs + Date.now() - t0,
    usage: { ...usage },
    cancellation: { checked: false, outcome: "not-triggered" },
    cleanup: { strayProcesses: 0, leftoverTempEntries: [] },
    ...fields,
  });
  mkdirSync(args.records, { recursive: true });
  writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n");
  return record;
}

/** CLI processes started through the spy that are still running. */
function strayCliProcesses(): number {
  let commands: string[];
  try {
    commands = execFileSync("ps", ["-A", "-o", "command="], {
      encoding: "utf-8",
    }).split("\n");
  } catch {
    // Slim container images ship without ps.
    commands = readdirSync("/proc")
      .filter((pid) => /^\d+$/.test(pid))
      .map((pid) => {
        try {
          return readFileSync(`/proc/${pid}/cmdline`, "utf-8");
        } catch {
          return "";
        }
      });
  }
  return commands.filter((c) => c.includes("claude-spy.cjs")).length;
}

// Main -------------------------------------------------------------------------

let exitCode = 1;
try {
  // Scope, limits and stop conditions are on disk before the first request.
  writeRecord({
    stoppedBy: "incomplete",
    reasons: ["the run has not finished"],
  });
  console.log(`record: ${recordPath}`);

  const credBefore =
    !inContainer && credentialsFile ? statSync(credentials).mtimeMs : undefined;
  let harnessError: string | undefined;
  let startOk = false;
  try {
    if (args.scenario === "tool-turns-50") await runTurns();
    else if (args.scenario === "compaction-continuation") await runCompaction();
    else if (args.phase === "start") startOk = await runReplayStart();
    else await runReplayFinish(handoff!);
  } catch (err) {
    if (!(err instanceof StopRun)) {
      console.error(err);
      // The message may quote CLI output, so only the error type is kept.
      harnessError = `harness error: ${(err as Error)?.name ?? "unknown"}`;
    }
  }
  clearTimeout(deadline);

  // The provider reaps the CLI and its temp dir up to a second after the result.
  await new Promise((r) => setTimeout(r, 2000));
  const cleanup = {
    strayProcesses: strayCliProcesses(),
    leftoverTempEntries: readdirSync(scratch).filter((n) =>
      n.startsWith("pi-claude-"),
    ),
    ...(credBefore !== undefined
      ? {
          hostCredentialsUnchanged:
            statSync(credentials).mtimeMs === credBefore,
        }
      : {}),
  };
  const cleanupReasons = [
    ...(cleanup.strayProcesses
      ? [`${cleanup.strayProcesses} CLI processes still running`]
      : []),
    ...(cleanup.leftoverTempEntries.length
      ? [`${cleanup.leftoverTempEntries.length} temp entries left behind`]
      : []),
    ...(cleanup.hostCredentialsUnchanged === false
      ? ["host credentials file changed"]
      : []),
  ];
  const cancellation = cancelTrigger
    ? {
        checked: true,
        trigger: cancelTrigger,
        outcome: cleanupReasons.length ? "unclean" : "clean",
      }
    : { checked: false, outcome: "not-triggered" };

  if (args.phase === "start" && !stopReason && !harnessError) {
    // The finish phase writes the outcome; this one only records progress.
    const record = writeRecord({
      stoppedBy: "awaiting finish phase",
      reasons: startOk
        ? ["start phase done; finish in a fresh container"]
        : ["start phase did not issue the expected tool calls"],
      cancellation,
      cleanup,
    });
    console.log("RECORD " + JSON.stringify(record, null, 2));
    exitCode = startOk && !cleanupReasons.length ? 0 : 1;
  } else {
    const evaluation =
      args.phase === "start"
        ? { outcome: "failed" as const, reasons: [] }
        : evaluateScenario(args.scenario, observation);
    const reasons = [
      ...(stopReason ? [stopReason] : []),
      ...(harnessError ? [harnessError] : []),
      ...evaluation.reasons,
      ...cleanupReasons,
    ];
    const record = writeRecord({
      outcome: reasons.length ? "failed" : "passed",
      reasons,
      ...(stopReason ? { stoppedBy: stopReason } : {}),
      cancellation,
      cleanup,
    });
    console.log("RECORD " + JSON.stringify(record, null, 2));
    exitCode = record.outcome === "passed" ? 0 : 1;
  }
} catch (err) {
  console.error(err);
  exitCode = 2;
} finally {
  clearTimeout(deadline);
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(exitCode);
