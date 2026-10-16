import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export * from "./fake-upstream";

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

  const saved = {
    PATH: process.env.PATH,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  };
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
