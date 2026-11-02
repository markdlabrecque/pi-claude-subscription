/**
 * Per-request isolation for the Claude CLI subprocess.
 *
 * Builds the flags, environment and private working directory that keep Claude
 * Code's built-in tools and all host config (settings, CLAUDE.md, memory,
 * skills, hooks, plugins, slash commands, MCP servers) out of a request, and
 * make Pi's system prompt replace Claude Code's. Flags come from the spike
 * (README "Spike findings"). Never pass --settings, --plugin-dir or --agents:
 * they stay active under --setting-sources "".
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Isolation {
  /** Fresh private temp directory to run the CLI in. */
  cwd: string;
  /** CLI flags to add to the spawn arguments. */
  args: string[];
  /** Environment variables to add to the spawn environment. */
  env: Record<string, string>;
  /**
   * Remove the temp directory, retrying briefly on transient errors. Never
   * throws: it runs from subprocess event handlers, where a throw ends Pi.
   * Returns "confirmed" once the directory is gone, else "failed". Safe to
   * call more than once.
   */
  cleanup(): SandboxCleanup;
}

export type SandboxCleanup = "confirmed" | "failed";

/**
 * Errors a later attempt can clear, as in Node's own rm retries. ENOTEMPTY is
 * an entry created while the recursive remove runs; EBUSY/EPERM are Windows
 * handles still open.
 */
const TRANSIENT = new Set(["ENOTEMPTY", "EBUSY", "EPERM", "EMFILE", "ENFILE"]);
const CLEANUP_ATTEMPTS = 5;
const CLEANUP_RETRY_MS = 10;

/** Synchronous so callers keep a plain outcome; at most ~100ms in total. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Remove only `dir`, the request's own mkdtemp directory. */
function removeDir(dir: string): SandboxCleanup {
  for (let attempt = 1; ; attempt++) {
    let code: string | undefined;
    try {
      rmSync(dir, { recursive: true, force: true });
      // A writer can still recreate it; only an absent directory is confirmed
      if (!existsSync(dir)) return "confirmed";
      code = "ENOTEMPTY";
    } catch (err) {
      code = (err as NodeJS.ErrnoException)?.code;
    }
    if (!code || !TRANSIENT.has(code) || attempt >= CLEANUP_ATTEMPTS)
      return "failed";
    pause(CLEANUP_RETRY_MS * attempt);
  }
}

/**
 * The CLI prepends this environment reminder even with a replacement system
 * prompt. Its fresh transport cwd must not invalidate the whole replay prefix.
 * Only the leading CLI-generated block is eligible; Pi's replay turns and
 * instructions are left intact, including any real workspace changes.
 */
export function normalizeCliEnvironment(payload: unknown): void {
  const body = payload as {
    messages?: {
      role?: string;
      content?: { type?: string; text?: string }[];
    }[];
  } | null;
  if (!body || !Array.isArray(body.messages)) return;
  const first = body.messages[0];
  if (first?.role !== "user" || !Array.isArray(first.content)) return;
  const block = first.content[0];
  if (block?.type !== "text" || typeof block.text !== "string") return;
  block.text = block.text.replace(
    /^(<system-reminder>\n# Environment\nYou have been invoked in the following environment: \n - Primary working directory: )[^\r\n]*[/\\]pi-claude-subscription-[A-Za-z0-9]{6}(?=\r?\n)/,
    "$1[private CLI transport directory, not the Pi workspace]",
  );
}

/** Stands in when Pi sends no prompt, so Claude Code's own never comes back. */
const FALLBACK_SYSTEM_PROMPT = "You are a helpful assistant.";

export function createIsolation(systemPrompt?: string): Isolation {
  const cwd = mkdtempSync(join(tmpdir(), "pi-claude-subscription-"));
  let removed = false;
  const cleanup = (): SandboxCleanup => {
    if (removed) return "confirmed";
    const outcome = removeDir(cwd);
    removed = outcome === "confirmed";
    return outcome;
  };

  try {
    const args = [
      "--tools",
      "",
      "--setting-sources",
      "",
      "--disable-slash-commands",
      "--strict-mcp-config",
    ];
    // A file avoids ENAMETOOLONG on Windows; it lives in the private dir.
    const promptFile = join(cwd, "system-prompt.txt");
    writeFileSync(promptFile, systemPrompt || FALLBACK_SYSTEM_PROMPT, "utf-8");
    args.push("--system-prompt-file", promptFile);

    return {
      cwd,
      args,
      env: {
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      },
      cleanup,
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}
