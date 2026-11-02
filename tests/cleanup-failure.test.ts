import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createIsolation } from "../src/isolation";
import { spawnClaude } from "../src/process-manager";
import { streamViaCli } from "../src/provider";
import {
  installFakeClaude,
  startFakeUpstream,
  model,
  type FakeClaude,
  type FakeUpstream,
} from "./harness";

const state = vi.hoisted(() => ({
  /** Removals of a request temp directory that fail before one goes through. */
  failures: 0,
  code: "ENOTEMPTY",
  removed: [] as string[],
  writeError: undefined as Error | undefined,
  spawnError: undefined as Error | undefined,
  records: [] as Record<string, any>[],
}));

const errno = (code: string, path: string) =>
  Object.assign(new Error(`${code}: ${path}`), { code });

// Pass-through fs: only request temp directories can be made to fail
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const { basename } = await import("node:path");
  const rmSync: typeof fs.rmSync = (path, options) => {
    if (basename(String(path)).startsWith("pi-claude-subscription-")) {
      state.removed.push(String(path));
      if (state.failures > 0) {
        state.failures--;
        throw errno(state.code, String(path));
      }
    }
    return fs.rmSync(path, options);
  };
  const writeFileSync: typeof fs.writeFileSync = (file, data, options) => {
    if (state.writeError) throw state.writeError;
    return fs.writeFileSync(file, data, options);
  };
  const mocked = { ...fs, rmSync, writeFileSync };
  return { ...mocked, default: mocked };
});
vi.mock("cross-spawn", async (importOriginal) => {
  const real = ((await importOriginal()) as any).default;
  return {
    default: (...args: any[]) => {
      if (state.spawnError) throw state.spawnError;
      return real(...args);
    },
  };
});
vi.mock("../src/audit", () => ({
  createAuditSink: () => ({
    append: async (record: Record<string, unknown>) => {
      state.records.push(structuredClone(record));
    },
  }),
}));

let sandbox: string;
let upstream: FakeUpstream | undefined;
let claude: FakeClaude | undefined;

beforeEach(() => {
  Object.assign(state, {
    failures: 0,
    code: "ENOTEMPTY",
    removed: [],
    writeError: undefined,
    spawnError: undefined,
    records: [],
  });
  sandbox = mkdtempSync(join(tmpdir(), "cleanup-failure-"));
  vi.stubEnv("TMPDIR", sandbox);
});
afterEach(async () => {
  claude?.restore();
  await upstream?.close();
  claude = upstream = undefined;
  vi.unstubAllEnvs();
  state.failures = 0;
  state.writeError = undefined;
  rmSync(sandbox, { recursive: true, force: true });
});

const leftover = () =>
  readdirSync(sandbox).filter((d) => d.startsWith("pi-claude-subscription-"));

describe("removing a request temp directory", () => {
  it("retries a transient ENOTEMPTY and verifies the directory is gone", () => {
    const isolation = createIsolation("x");
    state.failures = 2;

    expect(isolation.cleanup()).toBe("confirmed");

    expect(existsSync(isolation.cwd)).toBe(false);
    expect(state.removed).toEqual([
      isolation.cwd,
      isolation.cwd,
      isolation.cwd,
    ]);
  });

  it("stops after a bounded number of attempts and reports failure instead of throwing", () => {
    const isolation = createIsolation("x");
    state.failures = Infinity;

    let outcome: string | undefined;
    expect(() => (outcome = isolation.cleanup())).not.toThrow();

    expect(outcome).toBe("failed");
    expect(state.removed.length).toBeGreaterThan(1);
    expect(state.removed.length).toBeLessThanOrEqual(10);
    // Only the request's own directory is ever removed
    expect(new Set(state.removed)).toEqual(new Set([isolation.cwd]));
    expect(existsSync(isolation.cwd)).toBe(true);
  });

  it("does not retry an error that will not clear by itself", () => {
    const isolation = createIsolation("x");
    state.failures = 1;
    state.code = "EACCES";

    expect(isolation.cleanup()).toBe("failed");
    expect(state.removed).toHaveLength(1);
  });

  it("can be called again: after success it never removes anything twice", () => {
    const isolation = createIsolation("x");

    expect(isolation.cleanup()).toBe("confirmed");
    expect(isolation.cleanup()).toBe("confirmed");
    expect(state.removed).toEqual([isolation.cwd]);
  });

  it("can be called again: a later call can still remove a directory it failed on", () => {
    const isolation = createIsolation("x");
    state.failures = Infinity;
    expect(isolation.cleanup()).toBe("failed");

    state.failures = 0;
    expect(isolation.cleanup()).toBe("confirmed");
    expect(existsSync(isolation.cwd)).toBe(false);
  });
});

describe("a failed cleanup does not mask the original error", () => {
  it("when writing the system prompt file fails", () => {
    state.writeError = errno("ENOSPC", "system-prompt.txt");
    state.failures = Infinity;

    expect(() => createIsolation("x")).toThrow("ENOSPC");
    expect(leftover()).toHaveLength(1);
  });

  it("when spawning the CLI fails", () => {
    state.spawnError = errno("EAGAIN", "spawn claude");
    state.failures = Infinity;

    expect(() => spawnClaude("claude-sonnet-4-5")).toThrow("EAGAIN");
    expect(leftover()).toHaveLength(1);
  });

  it("when spawning the CLI fails, the directory is still removed if it can be", () => {
    state.spawnError = errno("EAGAIN", "spawn claude");
    state.failures = 2;

    expect(() => spawnClaude("claude-sonnet-4-5")).toThrow("EAGAIN");
    expect(leftover()).toEqual([]);
  });
});

describe("audit reports the request temp directory cleanup", () => {
  it.each([
    ["never confirms a persistent failure", Infinity, "failed", 1],
    ["confirms a transient failure that was retried", 2, "confirmed", 0],
  ] as const)("%s", async (_name, failures, sandboxOutcome, left) => {
    vi.stubEnv("HOME", sandbox);
    vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_AUDIT", "1");
    vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_DEBUG", "0");
    vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_SESSION_MODE", "replay");
    vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_API_KEY_FALLBACK", "0");
    upstream = await startFakeUpstream(["normal"]);
    claude = installFakeClaude(upstream.url);
    state.failures = failures;

    const stream = streamViaCli(model, {
      messages: [{ role: "user", content: "Hi", timestamp: 1 }],
    });
    expect((await stream.result()).stopReason).toBe("stop");

    await vi.waitFor(() =>
      expect(
        state.records.filter((r) => r.event === "request_terminal"),
      ).toHaveLength(1),
    );
    const end = state.records.find((r) => r.event === "request_terminal")!;
    expect(end.cleanup).toMatchObject({
      attempted: true,
      process: "confirmed",
      sandbox: sandboxOutcome,
    });
    // Only request temp directories were ever removed
    for (const path of state.removed)
      expect(basename(path)).toMatch(/^pi-claude-subscription-[A-Za-z0-9]{6}$/);
    expect(leftover()).toHaveLength(left);
  });
});
