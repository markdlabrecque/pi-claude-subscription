/**
 * Opt-in per-request diagnostics, written only under the debug flag.
 *
 * One single-line JSON record per CLI request tells an empty exit, a
 * partial-output failure, a cancellation and a timeout apart. It carries
 * versions, flags, exit status and relay counts only: never prompts, output,
 * stderr, tool arguments, headers, tokens or paths. A failed turn is reported
 * by the stream itself; this record is never needed to detect one.
 */

import { exec } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";

/** Why a CLI request ended. */
export type TerminalReason =
  | "completed"
  | "tool-use"
  | "result-error"
  | "upstream-error"
  | "cancelled"
  | "timed-out"
  | "inactivity-timeout"
  | "empty-exit"
  | "exit-without-result"
  | "cli-exit-error"
  | "killed"
  | "resume-lost"
  | "error";

export interface RequestDiagnostics {
  requestId: string;
  terminalReason: TerminalReason;
  extensionVersion: string | null;
  piVersion: string | null;
  cliVersion: string | null;
  sawMessageStart: boolean;
  sawMessageStop: boolean;
  sawResult: boolean;
  exitCode: number | null;
  signal: string | null;
  cancelled: boolean;
  timedOut: boolean;
  upstreamCount: number;
  rejectedCount: number;
}

/** How long to wait for the CLI to exit or a version probe before logging anyway. */
const SETTLE_MS = 5000;

let extensionVersion: string | null | undefined;

/** This extension's package.json version. */
function getExtensionVersion(): string | null {
  if (extensionVersion !== undefined) return extensionVersion;
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    extensionVersion =
      JSON.parse(readFileSync(join(dir, "..", "package.json"), "utf-8"))
        .version ?? null;
  } catch {
    extensionVersion = null;
  }
  return extensionVersion ?? null;
}

let piVersion: Promise<string | null> | undefined;

/** The host Pi version, from the Pi 1.x coding agent that loaded us. */
function getPiVersion(): Promise<string | null> {
  piVersion ??= import("@earendil-works/pi-coding-agent").then(
    (pi) => pi.VERSION ?? null,
    () => null,
  );
  return piVersion;
}

/** The Claude CLI version, probed per request since the CLI can update itself. */
function getCliVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    exec("claude --version", { timeout: SETTLE_MS }, (err, stdout) =>
      resolve(err ? null : (stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null)),
    );
  });
}

/** Resolve once the process has exited, or after SETTLE_MS. */
function whenExited(proc: ChildProcess | undefined): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, SETTLE_MS);
    timer.unref();
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Start collecting diagnostics for one request. The version probes start now,
 * so they overlap the request; `finish` writes the record once the CLI exits.
 */
export function startRequestDiagnostics(
  log: (line: string) => void = (line) =>
    console.error(`[pi-claude-subscription] ${line}`),
) {
  const versions = Promise.all([getPiVersion(), getCliVersion()]);
  return {
    async finish(
      proc: ChildProcess | undefined,
      describe: (
        exitCode: number | null,
        signal: string | null,
      ) => Omit<
        RequestDiagnostics,
        "extensionVersion" | "piVersion" | "cliVersion" | "exitCode" | "signal"
      >,
    ): Promise<void> {
      try {
        await whenExited(proc);
        const exitCode = proc?.exitCode ?? null;
        const signal = proc?.signalCode ?? null;
        const [pi, cli] = await versions;
        const record: RequestDiagnostics = {
          ...describe(exitCode, signal),
          extensionVersion: getExtensionVersion(),
          piVersion: pi,
          cliVersion: cli,
          exitCode,
          signal,
        };
        log(`request diagnostics ${JSON.stringify(record)}`);
      } catch {
        // Diagnostics must never affect a request
      }
    },
  };
}
