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

/** How removing the private temp directory ended. */
export type SandboxCleanup = "confirmed" | "failed";

export interface Isolation {
  /** Fresh private temp directory to run the CLI in. */
  cwd: string;
  /** CLI flags to add to the spawn arguments. */
  args: string[];
  /** Environment variables to add to the spawn environment. */
  env: Record<string, string>;
  /**
   * Remove the temp directory. Safe to call more than once: every call shares
   * one attempt. Never throws or rejects, so it is safe in event handlers.
   */
  cleanup(): Promise<SandboxCleanup>;
}

/** Errors a busy directory can raise (e.g. a late CLI write) and outgrow. */
const TRANSIENT_RM_ERRORS = new Set([
  "ENOTEMPTY",
  "EBUSY",
  "EPERM",
  "EMFILE",
  "ENFILE",
]);
/** Waits between attempts; bounded so a stuck directory gives up quickly. */
const RM_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320];

/**
 * Remove only `dir`, retrying transient failures with backoff. Removal counts
 * only once the directory is verifiably gone. The first attempt is synchronous.
 */
function removeDir(dir: string): Promise<SandboxCleanup> {
  const attempt = (retry: number): SandboxCleanup | Promise<SandboxCleanup> => {
    let transient = true;
    try {
      rmSync(dir, { recursive: true, force: true });
      if (!existsSync(dir)) return "confirmed";
    } catch (err) {
      transient = TRANSIENT_RM_ERRORS.has((err as NodeJS.ErrnoException).code!);
    }
    if (!transient || retry >= RM_RETRY_DELAYS_MS.length) return "failed";
    return new Promise((resolve) => {
      setTimeout(
        () => resolve(attempt(retry + 1)),
        RM_RETRY_DELAYS_MS[retry],
      ).unref?.();
    });
  };
  return Promise.resolve(attempt(0));
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
  let removal: Promise<SandboxCleanup> | undefined;
  const cleanup = () => (removal ??= removeDir(cwd));

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
    // Best effort; cleanup never throws, so the setup error is what surfaces
    void cleanup();
    throw err;
  }
}
