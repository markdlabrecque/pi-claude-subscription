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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Isolation {
  /** Fresh private temp directory to run the CLI in. */
  cwd: string;
  /** CLI flags to add to the spawn arguments. */
  args: string[];
  /** Environment variables to add to the spawn environment. */
  env: Record<string, string>;
  /** Remove the temp directory. Safe to call more than once. */
  cleanup(): void;
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
  const cleanup = () => rmSync(cwd, { recursive: true, force: true });

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
