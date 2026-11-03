import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";

// rmSync can be made to fail the way a busy temp directory does (ENOTEMPTY),
// while still doing real removal once the failure is switched off.
const fsControl = vi.hoisted(() => ({
  rmFailures: 0, // number of upcoming rmSync calls that throw; Infinity = always
  rmCalls: [] as string[],
  writeError: null as Error | null,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    rmSync: ((path: any, options: any) => {
      fsControl.rmCalls.push(String(path));
      if (fsControl.rmFailures > 0) {
        fsControl.rmFailures--;
        throw Object.assign(
          new Error(`ENOTEMPTY, Directory not empty: ${String(path)}`),
          { code: "ENOTEMPTY", syscall: "rmdir" },
        );
      }
      return actual.rmSync(path, options);
    }) as typeof actual.rmSync,
    writeFileSync: ((...a: any[]) => {
      if (fsControl.writeError) throw fsControl.writeError;
      return (actual.writeFileSync as any)(...a);
    }) as typeof actual.writeFileSync,
  };
});

let spawnImpl: () => any;
vi.mock("cross-spawn", () => ({ default: vi.fn(() => spawnImpl()) }));
vi.mock("node:child_process", () => ({ execSync: vi.fn() }));

import spawn from "cross-spawn";
import { spawnClaude, observeProcessCleanup } from "../src/process-manager";
import { createIsolation } from "../src/isolation";

function fakeProc(): any {
  const proc: any = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

function spawnedCwd(): string {
  return (spawn as any).mock.calls.at(-1)[2].cwd;
}

beforeEach(() => {
  vi.clearAllMocks();
  fsControl.rmFailures = 0;
  fsControl.rmCalls = [];
  fsControl.writeError = null;
  spawnImpl = fakeProc;
});

afterEach(() => {
  fsControl.rmFailures = 0;
  fsControl.writeError = null;
});

describe("temporary-directory cleanup failure", () => {
  it("retries a transient ENOTEMPTY and verifies the directory is gone", async () => {
    const proc = spawnClaude("claude-sonnet-4-5-20250929");
    const cwd = spawnedCwd();
    fsControl.rmFailures = 2;

    expect(() => proc.emit("close", 0, null)).not.toThrow();

    await vi.waitFor(
      async () => {
        expect((await observeProcessCleanup(proc)).sandbox).toBe("confirmed");
      },
      { timeout: 5000 },
    );
    expect(existsSync(cwd)).toBe(false);
    expect(fsControl.rmCalls.filter((p) => p === cwd).length).toBeGreaterThan(
      2,
    );
  });

  it("does not crash the host on persistent failure, and reports it as failed", async () => {
    const proc = spawnClaude("claude-sonnet-4-5-20250929");
    const cwd = spawnedCwd();
    fsControl.rmFailures = Infinity;

    expect(() => proc.emit("close", 0, null)).not.toThrow();

    await vi.waitFor(
      async () => {
        expect((await observeProcessCleanup(proc)).sandbox).toBe("failed");
      },
      { timeout: 10000 },
    );
    // Bounded: it gave up rather than retrying forever
    const attempts = fsControl.rmCalls.filter((p) => p === cwd).length;
    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThanOrEqual(20);
    await new Promise((r) => setTimeout(r, 300));
    expect(fsControl.rmCalls.filter((p) => p === cwd).length).toBe(attempts);

    // Never reported as confirmed
    expect((await observeProcessCleanup(proc)).sandbox).toBe("failed");

    fsControl.rmFailures = 0;
    (await import("node:fs")).rmSync(cwd, { recursive: true, force: true });
  });

  it("only removes the request-owned directory", async () => {
    const proc = spawnClaude("claude-sonnet-4-5-20250929");
    const cwd = spawnedCwd();

    proc.emit("close", 0, null);
    await vi.waitFor(async () => {
      expect((await observeProcessCleanup(proc)).sandbox).toBe("confirmed");
    });

    expect(fsControl.rmCalls.length).toBeGreaterThan(0);
    for (const p of fsControl.rmCalls) expect(p).toBe(cwd);
  });

  it("handles repeated cleanup (error then close) without throwing", async () => {
    const proc = spawnClaude("claude-sonnet-4-5-20250929");
    const cwd = spawnedCwd();

    expect(() => {
      proc.emit("error", new Error("spawn claude ENOENT"));
      proc.emit("close", 1, null);
    }).not.toThrow();

    await vi.waitFor(async () => {
      expect((await observeProcessCleanup(proc)).sandbox).toBe("confirmed");
    });
    expect(existsSync(cwd)).toBe(false);
  });

  it("repeated cleanup after a persistent failure still does not throw", async () => {
    const proc = spawnClaude("claude-sonnet-4-5-20250929");
    const cwd = spawnedCwd();
    fsControl.rmFailures = Infinity;

    expect(() => {
      proc.emit("error", new Error("boom"));
      proc.emit("close", 1, null);
    }).not.toThrow();

    await vi.waitFor(
      async () => {
        expect((await observeProcessCleanup(proc)).sandbox).toBe("failed");
      },
      { timeout: 10000 },
    );
    fsControl.rmFailures = 0;
    (await import("node:fs")).rmSync(cwd, { recursive: true, force: true });
  });

  it("preserves the original spawn error when cleanup also fails", () => {
    const original = new Error("spawn exploded");
    spawnImpl = () => {
      throw original;
    };
    fsControl.rmFailures = Infinity;

    let thrown: unknown;
    try {
      spawnClaude("claude-sonnet-4-5-20250929");
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBe(original);
    const cwd = fsControl.rmCalls[0];
    fsControl.rmFailures = 0;
    if (cwd) {
      return import("node:fs").then((fs) =>
        fs.rmSync(cwd, { recursive: true, force: true }),
      );
    }
  });

  it("preserves the original setup error when cleanup also fails", async () => {
    const original = new Error("disk full while writing prompt");
    fsControl.writeError = original;
    fsControl.rmFailures = Infinity;

    let thrown: unknown;
    try {
      createIsolation("prompt");
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBe(original);
    const cwd = fsControl.rmCalls[0];
    fsControl.rmFailures = 0;
    if (cwd) {
      (await import("node:fs")).rmSync(cwd, { recursive: true, force: true });
    }
  });
});
