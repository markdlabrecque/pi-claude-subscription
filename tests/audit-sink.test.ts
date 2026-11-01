import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuditSink } from "../src/audit";

// Proposed low-level seam: createAuditSink({ extensionRoot, env, now?, warn?,
// maxFileBytes? }).append(record) is awaitable and never throws on I/O failure.
// Only this suite needs a clock or filesystem limits; production callers do not.
let root: string;
let outside: string;
const today = "2026-06-12";
const now = () => new Date(`${today}T23:59:59.000Z`);
const record = (requestId = "request-1") => ({
  event: "request_start",
  requestId,
  route: "cli",
  model: "claude-sonnet-4-5",
  sessionMode: "replay",
  versions: { extension: "0.4.0", pi: null, cli: null },
});
const dir = () => join(root, ".audit");
const file = () => join(dir(), `${today}.jsonl`);
const lines = () =>
  readFileSync(file(), "utf8")
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "audit-extension-"));
  outside = mkdtempSync(join(tmpdir(), "audit-outside-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function sink(
  env: Record<string, string | undefined> = {
    PI_CLAUDE_SUBSCRIPTION_AUDIT: "1",
  },
  extra = {},
) {
  return createAuditSink({ extensionRoot: root, env, now, ...extra });
}

describe("local audit sink", () => {
  it.each([undefined, "", "0", "false"])(
    "creates nothing when audit is %s, even with unsafe DEBUG enabled",
    async (flag) => {
      const s = sink({
        PI_CLAUDE_SUBSCRIPTION_AUDIT: flag,
        PI_CLAUDE_SUBSCRIPTION_DEBUG: "1",
        PI_CLAUDE_SUBSCRIPTION_AUDIT_DIR: outside,
      });
      await s.append(record());
      expect(readdirSync(root)).toEqual([]);
      expect(readdirSync(outside)).toEqual([]);
    },
  );

  it.each(["1", "true"])(
    "enables audit with %s independently of DEBUG and writes private UTC JSONL",
    async (flag) => {
      await sink({ PI_CLAUDE_SUBSCRIPTION_AUDIT: flag }).append(record());
      expect(lines()).toEqual([
        {
          ...record(),
          schemaVersion: 1,
          timestamp: `${today}T23:59:59.000Z`,
        },
      ]);
      if (process.platform !== "win32") {
        expect(statSync(dir()).mode & 0o777).toBe(0o700);
        expect(statSync(file()).mode & 0o777).toBe(0o600);
      }
    },
  );

  it("uses the supplied request env rather than ambient opt-in", async () => {
    vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_AUDIT", "1");
    await sink({ PI_CLAUDE_SUBSCRIPTION_AUDIT: "0" }).append(record());
    expect(readdirSync(root)).toEqual([]);
  });

  it("allows a nested directory inside extensionRoot", async () => {
    const nested = join(root, "local", "audit");
    await sink({
      PI_CLAUDE_SUBSCRIPTION_AUDIT: "true",
      PI_CLAUDE_SUBSCRIPTION_AUDIT_DIR: nested,
    }).append(record());
    expect(existsSync(join(nested, `${today}.jsonl`))).toBe(true);
    expect(existsSync(dir())).toBe(false);
  });

  it.each(["absolute", "traversal", "sibling-prefix", "symlink"])(
    "rejects an escaping %s path without revealing it or falling back",
    async (kind) => {
      let target = outside;
      if (kind === "traversal")
        target = join(root, "..", outside.split("/").at(-1)!);
      if (kind === "sibling-prefix") target = `${root}-private`;
      if (kind === "symlink") {
        symlinkSync(outside, join(root, "escape"), "junction");
        target = join(root, "escape", "new-directory");
      }
      const warn = vi.fn();
      await sink(
        {
          PI_CLAUDE_SUBSCRIPTION_AUDIT: "1",
          PI_CLAUDE_SUBSCRIPTION_AUDIT_DIR: target,
        },
        { warn },
      ).append(record());
      expect(existsSync(dir())).toBe(false);
      expect(readdirSync(outside)).toEqual([]);
      expect(existsSync(`${root}-private`)).toBe(false);
      const warning = JSON.stringify(warn.mock.calls);
      expect(warning).toMatch(/audit/i);
      expect(warning).toMatch(/invalid|reject|within|inside/i);
      expect(warning).not.toContain(root);
      expect(warning).not.toContain(outside);
      expect(warning).not.toContain("request-1");
    },
  );

  it.each([
    ["directory", false],
    ["directory", true],
    ["ancestor", false],
    ["ancestor", true],
    ["root", false],
    ["root", true],
  ] as const)(
    "rejects a %s symlink swap during lock contention, existing daily file: %s",
    async (component, existingDaily) => {
      const target = join(root, "local", "audit");
      mkdirSync(join(target, ".append-lock"), { recursive: true });
      const replaced =
        component === "directory"
          ? target
          : component === "ancestor"
            ? join(root, "local")
            : root;
      const victim =
        component === "directory"
          ? outside
          : component === "ancestor"
            ? join(outside, "audit")
            : join(outside, "local", "audit");
      mkdirSync(victim, { recursive: true, mode: 0o755 });
      const expired = join(victim, "2026-06-01.jsonl");
      const daily = join(victim, `${today}.jsonl`);
      writeFileSync(expired, "expired but outside\n");
      if (existingDaily)
        writeFileSync(daily, "outside daily\n", { mode: 0o644 });
      const mode = statSync(victim).mode;
      const warn = vi.fn();
      // append runs synchronously up to its first lock wait. No timing sleeps
      // or filesystem mocks: replace the directory while that wait is pending.
      const pending = sink(
        {
          PI_CLAUDE_SUBSCRIPTION_AUDIT: "1",
          PI_CLAUDE_SUBSCRIPTION_AUDIT_DIR: target,
        },
        { warn },
      ).append(record());
      const parked = `${root}-parked`;
      renameSync(replaced, parked);
      symlinkSync(outside, replaced, "dir");
      try {
        await expect(pending).resolves.toBeUndefined();
        expect(readdirSync(victim).sort()).toEqual(
          existingDaily
            ? ["2026-06-01.jsonl", `${today}.jsonl`]
            : ["2026-06-01.jsonl"],
        );
        expect(readFileSync(expired, "utf8")).toBe("expired but outside\n");
        if (existingDaily) {
          expect(readFileSync(daily, "utf8")).toBe("outside daily\n");
          expect(statSync(daily).mode & 0o777).toBe(0o644);
        }
        expect(statSync(victim).mode).toBe(mode);
        expect(warn).toHaveBeenCalled();
        expect(JSON.stringify(warn.mock.calls)).not.toContain(outside);
      } finally {
        unlinkSync(replaced);
        renameSync(parked, replaced);
      }
    },
  );

  it("rejects a different real directory at the same path after a lock wait", async () => {
    mkdirSync(join(dir(), ".append-lock"), { recursive: true });
    const warn = vi.fn();
    const pending = sink(undefined, { warn }).append(record());
    renameSync(dir(), join(root, "original-audit"));
    mkdirSync(dir());
    writeFileSync(join(dir(), "2026-06-01.jsonl"), "keep\n");
    await pending;
    expect(readdirSync(dir())).toEqual(["2026-06-01.jsonl"]);
    expect(readFileSync(join(dir(), "2026-06-01.jsonl"), "utf8")).toBe(
      "keep\n",
    );
    expect(warn).toHaveBeenCalled();
  });

  it("resumes a contended append when the original directory is unchanged", async () => {
    mkdirSync(join(dir(), ".append-lock"), { recursive: true });
    const warn = vi.fn();
    const pending = sink(undefined, { warn }).append(record());
    rmSync(join(dir(), ".append-lock"), { recursive: true });
    await pending;
    expect(lines()).toHaveLength(1);
    expect(existsSync(join(dir(), ".append-lock"))).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("revalidates after the clock callback before retention or writing", async () => {
    mkdirSync(dir());
    writeFileSync(join(outside, "2026-06-01.jsonl"), "keep outside\n");
    const warn = vi.fn();
    await sink(undefined, {
      warn,
      now: () => {
        renameSync(dir(), join(root, "original-audit"));
        symlinkSync(outside, dir(), "dir");
        return now();
      },
    }).append(record());
    expect(readdirSync(outside)).toEqual(["2026-06-01.jsonl"]);
    expect(readFileSync(join(outside, "2026-06-01.jsonl"), "utf8")).toBe(
      "keep outside\n",
    );
    expect(warn).toHaveBeenCalled();
  });

  it.each(["directory", "ancestor"])(
    "does not clean an outside lock after a warning callback swaps the %s",
    async (component) => {
      const target = join(root, "local", "audit");
      const replaced = component === "directory" ? target : join(root, "local");
      const victim =
        component === "directory" ? outside : join(outside, "audit");
      mkdirSync(join(victim, ".append-lock"), { recursive: true });
      writeFileSync(join(victim, "2026-06-01.jsonl"), "keep outside\n");
      let swapped = false;
      const warn = vi.fn(() => {
        if (swapped) return;
        renameSync(replaced, join(root, "original-directory"));
        symlinkSync(outside, replaced, "dir");
        swapped = true;
      });
      await sink(
        {
          PI_CLAUDE_SUBSCRIPTION_AUDIT: "1",
          PI_CLAUDE_SUBSCRIPTION_AUDIT_DIR: target,
        },
        { warn, maxFileBytes: 1 },
      ).append(record());
      expect(swapped).toBe(true);
      expect(readdirSync(victim).sort()).toEqual([
        ".append-lock",
        "2026-06-01.jsonl",
      ]);
      expect(readFileSync(join(victim, "2026-06-01.jsonl"), "utf8")).toBe(
        "keep outside\n",
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(outside);
    },
  );

  it("does not remove a replacement lock in the original directory", async () => {
    const warn = vi.fn().mockImplementationOnce(() => {
      renameSync(join(dir(), ".append-lock"), join(dir(), ".owned-lock"));
      mkdirSync(join(dir(), ".append-lock"));
    });
    await sink(undefined, { warn, maxFileBytes: 1 }).append(record());
    expect(existsSync(join(dir(), ".append-lock"))).toBe(true);
    expect(existsSync(join(dir(), ".owned-lock"))).toBe(true);
  });

  it("does not follow a pre-existing daily-file symlink", async () => {
    mkdirSync(dir());
    const secret = join(outside, "private.jsonl");
    writeFileSync(secret, "untouched\n");
    symlinkSync(secret, file());
    const warn = vi.fn();
    await sink(undefined, { warn }).append(record());
    expect(readFileSync(secret, "utf8")).toBe("untouched\n");
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(outside);
  });

  it("warns without throwing or raw filesystem errors when writing is impossible", async () => {
    // Deterministic even as root: a regular file cannot be an audit directory.
    writeFileSync(dir(), "private-file-content");
    const warn = vi.fn();
    await expect(
      sink(undefined, { warn }).append(record()),
    ).resolves.toBeUndefined();
    const warning = JSON.stringify(warn.mock.calls);
    expect(warning).toMatch(/audit/i);
    expect(warning).toMatch(/fail|unable|could not/i);
    expect(warning).not.toMatch(
      /ENOTDIR|EACCES|private-file-content|request-1/,
    );
    expect(warning).not.toContain(root);
  });

  it("allowlists records, including nested objects, rather than serializing supplied raw data", async () => {
    const secret = "SYNTHETIC-RAW-CONTENT-AND-CREDENTIAL";
    await sink().append({
      ...record(),
      prompt: secret,
      output: secret,
      toolArgs: { text: secret },
      toolResult: secret,
      attachment: secret,
      headers: { authorization: secret },
      apiKey: secret,
      token: secret,
      accountId: secret,
      cwd: secret,
      stderr: secret,
      error: new Error(secret),
      versions: { extension: "0.4.0", pi: null, cli: null, raw: secret },
    });
    expect(readFileSync(file(), "utf8")).not.toContain(secret);
    expect(lines()[0]).toEqual({
      ...record(),
      schemaVersion: 1,
      timestamp: `${today}T23:59:59.000Z`,
    });
  });

  it("rotates at UTC midnight and removes expired daily logs, not unrelated files", async () => {
    mkdirSync(dir());
    for (const date of ["2026-06-01", "2026-06-04", "2026-06-11"]) {
      writeFileSync(join(dir(), `${date}.jsonl`), "{}\n");
    }
    writeFileSync(join(dir(), "notes.txt"), "keep");
    let clock = new Date(`${today}T23:59:59.000Z`);
    const s = sink(undefined, { now: () => clock });
    await s.append(record());
    clock = new Date("2026-06-13T00:00:00.000Z");
    await s.append(record("request-2"));
    expect(existsSync(join(dir(), "2026-06-01.jsonl"))).toBe(false);
    expect(existsSync(join(dir(), "2026-06-04.jsonl"))).toBe(false);
    expect(existsSync(join(dir(), "2026-06-11.jsonl"))).toBe(true);
    expect(readFileSync(join(dir(), "notes.txt"), "utf8")).toBe("keep");
    expect(
      JSON.parse(readFileSync(join(dir(), "2026-06-13.jsonl"), "utf8"))
        .requestId,
    ).toBe("request-2");
  });

  it("keeps the daily file bounded and all retained lines parseable", async () => {
    const maxFileBytes = 2048;
    const s = sink(undefined, { maxFileBytes });
    for (let i = 0; i < 80; i++) await s.append(record(`request-${i}`));
    expect(statSync(file()).size).toBeLessThanOrEqual(maxFileBytes);
    expect(lines().length).toBeGreaterThan(0);
    for (const entry of lines()) expect(entry.event).toBe("request_start");
  });

  it("appends concurrent requests from independent sink instances without losing or interleaving lines", async () => {
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        sink().append(record(`request-${i}`)),
      ),
    );
    expect(lines()).toHaveLength(40);
    expect(new Set(lines().map((r) => r.requestId)).size).toBe(40);
  });

  it("leaves an orphan start incomplete instead of inventing a terminal record", async () => {
    await sink().append(record());
    expect(lines().map((r) => r.event)).toEqual(["request_start"]);
  });
});
