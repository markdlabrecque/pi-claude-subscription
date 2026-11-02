import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFakeClaude, type FakeClaude } from "./harness";

// Each case runs a separate host process (tests/harness/cleanup-host.ts), so
// an exception escaping the subprocess 'close' handler really ends a process.
const HOST = join(__dirname, "harness", "cleanup-host.ts");
const VITE_NODE = join(
  __dirname,
  "..",
  "node_modules",
  "vite-node",
  "vite-node.mjs",
);

let sandbox: string;
let claude: FakeClaude | undefined;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "cleanup-host-"));
});
afterEach(() => {
  claude?.restore();
  claude = undefined;
  rmSync(sandbox, { recursive: true, force: true });
});

function runHost(wiring: "direct" | "spawn", failures: string) {
  // The fake CLI exits on SIGKILL before it would contact any upstream
  if (wiring === "spawn") claude = installFakeClaude("http://127.0.0.1:9");
  const run = spawnSync(process.execPath, [VITE_NODE, HOST], {
    env: {
      ...process.env,
      TMPDIR: sandbox,
      HOST_WIRING: wiring,
      HOST_RM_FAILURES: failures,
    },
    encoding: "utf-8",
    timeout: 60_000,
  });
  return {
    status: run.status,
    stderr: run.stderr,
    report: run.stdout ? JSON.parse(run.stdout) : undefined,
    left: readdirSync(sandbox).filter((d) =>
      d.startsWith("pi-claude-subscription-"),
    ),
  };
}

describe("a temp-directory cleanup failure at subprocess close", () => {
  it("cannot end the host, even with cleanup attached directly to the events", () => {
    const host = runHost("direct", "Infinity");

    expect(host.stderr).not.toContain("ENOTEMPTY");
    expect(host.status).toBe(0);
    expect(host.report).toEqual({ closed: true });
    // Never reported or treated as removed: the directory is still there
    expect(host.left).toHaveLength(1);
  });

  it("is retried when transient, and the directory is removed", () => {
    const host = runHost("direct", "2");

    expect(host.status).toBe(0);
    expect(host.left).toEqual([]);
  });

  it.each([
    ["persistent", "Infinity", "failed", 1],
    ["transient", "2", "confirmed", 0],
  ] as const)(
    "is reported through spawnClaude's cleanup observation (%s)",
    (_name, failures, sandboxOutcome, left) => {
      const host = runHost("spawn", failures);

      expect(host.stderr).not.toContain("ENOTEMPTY");
      expect(host.status).toBe(0);
      expect(host.report).toEqual({
        closed: true,
        cleanup: { process: "confirmed", sandbox: sandboxOutcome },
      });
      expect(host.left).toHaveLength(left);
    },
  );
});
