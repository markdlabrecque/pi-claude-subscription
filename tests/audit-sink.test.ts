import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
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
