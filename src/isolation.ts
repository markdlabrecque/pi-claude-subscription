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
