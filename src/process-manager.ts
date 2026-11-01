/**
 * Process manager for spawning and managing Claude CLI subprocesses.
 *
 * Handles subprocess lifecycle: spawn with correct CLI flags, write NDJSON
 * messages to stdin, force-kill after result (CLI hangs bug), and stderr capture.
 * Also provides startup validation for CLI presence and authentication.
 */

import spawn from "cross-spawn";
import { execSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createIsolation } from "./isolation.js";

/**
 * Credentials the CLI would prefer over the subscription login, and a parent
 * Claude Code session's identity, which would make the CLI report itself as
 * Claude Code rather than a separate client.
 */
const STRIPPED_ENV = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
]);

/**
 * Spawn a Claude CLI subprocess with all required flags for stream-json communication.
 *
 * @param modelId - The model ID to pass via --model flag
 * @param systemPrompt - Pi's system prompt; it always replaces Claude Code's
 * (a minimal one stands in when empty)
 * @param options - Abort signal, effort, MCP config, session ids, stateless mode and relay URL
 * @returns The spawned ChildProcess with piped stdin/stdout/stderr
 */
export function spawnClaude(
  modelId: string,
  systemPrompt?: string,
  options?: {
    signal?: AbortSignal;
    effort?: string;
    mcpConfigPath?: string;
    resumeSessionId?: string;
    newSessionId?: string;
    /** Replay mode: leave no CLI session state behind. */
    stateless?: boolean;
    /** Relay base URL; the CLI sends its API traffic here. */
    baseUrl?: string;
    /** The request's environment; defaults to the process environment. */
    env?: Readonly<Record<string, string | undefined>>;
  },
): ChildProcess {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    modelId,
    "--permission-prompt-tool",
    "stdio",
  ];

  if (options?.resumeSessionId) {
    // Resume an existing session — CLI loads prior conversation from disk
    args.push("--resume", options.resumeSessionId);
    // A resumed session freezes its first system prompt; this lets ours apply
    args.push("--system-prompt-snapshot", "off");
  } else if (options?.newSessionId) {
    // First turn: create session with this ID so subsequent turns can --resume it
    args.push("--session-id", options.newSessionId);
  } else if (options?.stateless) {
    args.push("--no-session-persistence");
  }

  if (options?.effort) {
    args.push("--effort", options.effort);
  }

  if (options?.mcpConfigPath) {
    args.push("--mcp-config", options.mcpConfigPath);
  }

  // Private temp cwd, removed once the process is gone (or if spawning fails)
  const isolation = createIsolation(systemPrompt);
  try {
    // Keep the CLI on the subscription: no API key or other provider may
    // switch it to API billing behind the relay's back, and it must not pass
    // itself off as a parent Claude Code session. This runs on the request's
    // environment, so scoped values cannot bring these back either.
    const env = { ...(options?.env ?? process.env) };
    for (const key of Object.keys(env)) {
      if (STRIPPED_ENV.has(key) || key.startsWith("CLAUDE_CODE_USE_")) {
        delete env[key];
      }
    }

    const proc = spawn("claude", [...args, ...isolation.args], {
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group, so the whole tree can be killed at once
      detached: process.platform !== "win32",
      cwd: isolation.cwd,
      env: {
        ...env,
        ...isolation.env,
        ...(options?.baseUrl && {
          ANTHROPIC_BASE_URL: options.baseUrl,
          // Suppresses the Haiku session-title request, so the relay's first
          // Messages request is the real one.
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        }),
      },
    });
    // Reap anything the CLI left running in its group
    proc.once("exit", () => killProcessGroup(proc));
    proc.once("close", isolation.cleanup);
    proc.once("error", isolation.cleanup);
    return proc as ChildProcess;
  } catch (err) {
    isolation.cleanup();
    throw err;
  }
}

/**
 * Write a user message to the subprocess stdin as NDJSON.
 * Does NOT call stdin.end() -- stdin stays open for control_response replies.
 *
 * Accepts both string (text-only prompt) and array (ContentBlock[] with images)
 * content. JSON.stringify handles both natively. The stream-json protocol
 * supports either format in the content field.
 *
 * @param proc - The Claude subprocess
 * @param prompt - The prompt text or ContentBlock[] to send
 */
export function writeUserMessage(
  proc: ChildProcess,
  prompt: string | any[],
): void {
  const message = {
    type: "user",
    message: {
      role: "user",
      content: prompt,
    },
  };
  proc.stdin!.write(JSON.stringify(message) + "\n");
}

/** Per-request timeout when the env var is unset or invalid: 10 minutes. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

export const REQUEST_TIMEOUT_ENV = "PI_CLAUDE_SUBSCRIPTION_TIMEOUT_MS";

/** Per-request timeout in ms; read on every request. */
export function getRequestTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const value = Number(env[REQUEST_TIMEOUT_ENV]);
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_REQUEST_TIMEOUT_MS;
}

/** SIGKILL the process group the CLI leads (macOS/Linux). Ignores a gone group. */
function killProcessGroup(proc: ChildProcess): void {
  if (process.platform === "win32" || typeof proc.pid !== "number") return;
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    // Group already gone
  }
}

/**
 * Force-kill a subprocess and everything it started via SIGKILL.
 * No-ops if the process is already dead (killed or exited).
 * Cross-platform safe: Node.js treats SIGKILL as forceful termination on Windows.
 *
 * @param proc - The subprocess to force-kill
 */
export function forceKillProcess(proc: ChildProcess): void {
  if (proc.killed || proc.exitCode !== null || proc.signalCode) return;
  killProcessGroup(proc);
  proc.kill("SIGKILL");
}

/** Registry of active subprocesses for cleanup on teardown. */
const activeProcesses = new Set<ChildProcess>();

/**
 * Register a subprocess in the global process registry.
 * The process is automatically removed from the registry when it exits.
 *
 * @param proc - The subprocess to track
 */
export function registerProcess(proc: ChildProcess): void {
  activeProcesses.add(proc);
  proc.on("exit", () => activeProcesses.delete(proc));
}

/**
 * Force-kill all registered subprocesses and clear the registry.
 * Safe to call multiple times -- no-ops on already-dead processes.
 */
export function killAllProcesses(): void {
  for (const proc of activeProcesses) {
    forceKillProcess(proc);
  }
  activeProcesses.clear();
}

/** Signals that end pi without running 'exit' listeners. */
const TERMINAL_SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];

/**
 * Kill every registered CLI tree, then re-raise the signal so pi still exits.
 * The re-raise only happens when nothing else is listening for the signal,
 * so an app-level handler keeps control of its own shutdown.
 *
 * @param signal - The terminal signal pi received
 */
export function onTerminalSignal(signal: NodeJS.Signals): void {
  killAllProcesses();
  if (process.listenerCount(signal) === 0) {
    process.kill(process.pid, signal);
  }
}

/**
 * Register cleanup for terminal signals. Each handler is removed before it
 * runs, so the re-raise in onTerminalSignal reaches the default action. When
 * an app handler still owns shutdown, cleanup is re-armed for the next signal.
 */
export function installSignalCleanup(): void {
  for (const signal of TERMINAL_SIGNALS) armSignal(signal);
}

function armSignal(signal: NodeJS.Signals): void {
  process.once(signal, () => {
    onTerminalSignal(signal);
    if (process.listenerCount(signal) > 0) armSignal(signal);
  });
}

/**
 * Force-kill the subprocess after a 500ms grace period.
 * The Claude CLI hangs after emitting the result message (known bug).
 * Brief grace period allows final stdout flushing before force-kill.
 *
 * @param proc - The Claude subprocess to clean up
 */
export function cleanupProcess(proc: ChildProcess): void {
  setTimeout(() => {
    forceKillProcess(proc);
  }, 500);
}

/**
 * Attach a data listener to stderr and accumulate output into a buffer.
 *
 * @param proc - The Claude subprocess
 * @returns A function that returns the accumulated stderr string
 */
export function captureStderr(proc: ChildProcess): () => string {
  let buffer = "";
  proc.stderr!.on("data", (data: Buffer) => {
    buffer += data.toString();
  });
  return () => buffer;
}

/** Tested Claude CLI range: `min` inclusive, `maxExclusive` exclusive. */
export const TESTED_CLI_RANGE = { min: "2.1.0", maxExclusive: "2.2.0" };

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Validate that the Claude CLI is installed and on PATH, and warn once if its
 * version is outside TESTED_CLI_RANGE.
 * Throws with install instructions if not found.
 */
export function validateCliPresence(): void {
  let output: string;
  try {
    output = execSync("claude --version", {
      stdio: "pipe",
      timeout: 5000,
    }).toString();
  } catch {
    throw new Error(
      "Claude Code CLI not found. Install it: npm install -g @anthropic-ai/claude-code\n" +
        "Then authenticate: claude auth login",
    );
  }

  const version = output.match(/\d+\.\d+\.\d+/)?.[0];
  const { min, maxExclusive } = TESTED_CLI_RANGE;
  if (
    !version ||
    compareVersions(version, min) < 0 ||
    compareVersions(version, maxExclusive) >= 0
  ) {
    console.warn(
      `[pi-claude-subscription] Claude CLI version ${version ?? output.trim()} is outside the tested range ` +
        `(>=${min} <${maxExclusive}); behavior may differ.`,
    );
  }
}

/**
 * Validate that the Claude CLI is authenticated.
 * Returns false and warns if not authenticated.
 *
 * @returns true if authenticated, false otherwise
 */
export function validateCliAuth(): boolean {
  try {
    execSync("claude auth status", { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    console.warn(
      "[pi-claude-subscription] Claude CLI is not authenticated. " +
        "Run 'claude auth login' to authenticate.",
    );
    return false;
  }
}
