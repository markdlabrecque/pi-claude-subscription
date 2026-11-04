import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import manifest from "../package.json";
import lockfile from "../package-lock.json";
import { installFakeClaude } from "./harness";

const root = join(__dirname, "..");

it("prepares a stable extension release independently of the pinned SDK pair", () => {
  expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(lockfile.version).toBe(manifest.version);
  expect(lockfile.packages[""].version).toBe(manifest.version);
  expect(manifest.devDependencies["@earendil-works/pi-ai"]).toBe("1.4.0");
  expect(manifest.devDependencies["@earendil-works/pi-coding-agent"]).toBe(
    "1.4.0",
  );
  expect(readFileSync(join(root, "docs/releases/v1.4.0.md"), "utf8")).toContain(
    "# v1.4.0 stable",
  );
});

it("records fresh standalone loader evidence from unpacked source with an isolated pinned host", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-release-audit-"));
  const claude = installFakeClaude("http://127.0.0.1:9");
  try {
    const [{ filename }] = JSON.parse(
      execFileSync(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--pack-destination", dir],
        { cwd: root, encoding: "utf8" },
      ),
    ) as Array<{ filename: string }>;
    execFileSync("tar", ["-xzf", join(dir, filename), "-C", dir]);
    const pkg = join(dir, "package");
    // Reuse only this worktree's pinned SDK/runtime dependencies. The package,
    // agent state, workspace and ledger are temporary, never personal settings.
    symlinkSync(join(root, "node_modules"), join(pkg, "node_modules"), "dir");
    const loader = join(pkg, "src/audit-loader-check.mjs");
    const env = {
      ...process.env,
      PI_CLAUDE_SUBSCRIPTION_AUDIT_DIR: ".audit",
      PI_CLAUDE_SUBSCRIPTION_API_KEY_FALLBACK: "0",
      PI_CLAUDE_SUBSCRIPTION_DEBUG: "0",
    };
    execFileSync(process.execPath, [loader], {
      cwd: dir,
      env: { ...env, PI_CLAUDE_SUBSCRIPTION_AUDIT: "0" },
      timeout: 30_000,
    });
    expect(existsSync(join(pkg, ".audit"))).toBe(false);
    execFileSync(process.execPath, [loader], {
      cwd: dir,
      env: { ...env, PI_CLAUDE_SUBSCRIPTION_AUDIT: "1" },
      timeout: 30_000,
    });
    const day = new Date().toISOString().slice(0, 10);
    const records = readFileSync(join(pkg, ".audit", `${day}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "extension_load",
          outcome: "success",
          reason: "registered",
          versions: { extension: manifest.version, pi: "1.4.0", cli: null },
        }),
      ]),
    );
  } finally {
    claude.restore();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
