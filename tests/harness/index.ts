import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export * from "./fake-upstream";

/** The pi model the provider is driven with in tests. */
export const model: any = {
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  api: "anthropic-messages",
  provider: "pi-claude-subscription",
  reasoning: false,
  input: ["text"],
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  contextWindow: 200000,
  maxTokens: 8192,
};

/** Write a CLI session file under `home`, as the fake claude reads it. */
export function writeSession(home: string, id: string, content: string): void {
  const dir = join(home, ".claude", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), content);
}

export interface FakeClaude {
  restore(): void;
}

/**
 * Put a fake `claude` first on PATH (and point ANTHROPIC_BASE_URL at the fake
 * upstream) so the provider spawns it instead of the real CLI.
 */
export function installFakeClaude(upstreamUrl: string): FakeClaude {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!/bin/sh\nexec "${process.execPath}" "${join(__dirname, "fake-claude.cjs")}" "$@"\n`,
  );
  chmodSync(bin, 0o755);
  // cross-spawn and Windows startup probes resolve the .cmd launcher.
  writeFileSync(
    join(dir, "claude.cmd"),
    `@echo off\r\n"${process.execPath}" "${join(__dirname, "fake-claude.cjs")}" %*\r\n`,
  );

  const saved = {
    PATH: process.env.PATH,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
  };
  // The suites use TMPDIR for request sandboxes. Node on Windows uses TEMP.
  if (process.platform === "win32" && process.env.TMPDIR) {
    process.env.TEMP = process.env.TMPDIR;
    process.env.TMP = process.env.TMPDIR;
  }
  process.env.PATH = `${dir}${delimiter}${saved.PATH}`;
  process.env.ANTHROPIC_BASE_URL = upstreamUrl;

  return {
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
