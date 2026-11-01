import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamViaCli } from "../src/provider";
import {
  installFakeClaude,
  startFakeUpstream,
  model,
  NORMAL_TEXT,
  type FakeClaude,
  type FakeUpstream,
} from "./harness";

// Exercise the real sink's failure path through the real provider. Override
// only its installation root, never point it at a user's extension directory.
const config = vi.hoisted(() => ({ extensionRoot: "" }));
vi.mock("../src/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/audit")>();
  return {
    ...actual,
    createAuditSink: (options: Parameters<typeof actual.createAuditSink>[0]) =>
      actual.createAuditSink({
        ...options,
        extensionRoot: config.extensionRoot,
      }),
  };
});
let upstream: FakeUpstream | undefined;
let claude: FakeClaude | undefined;
beforeEach(() => {
  config.extensionRoot = mkdtempSync(join(tmpdir(), "audit-write-failure-"));
  vi.stubEnv("HOME", config.extensionRoot);
  vi.stubEnv("TMPDIR", config.extensionRoot);
  vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_AUDIT", "1");
  vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_DEBUG", "0");
  vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_SESSION_MODE", "replay");
});
afterEach(async () => {
  claude?.restore();
  await upstream?.close();
  claude = upstream = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(config.extensionRoot, { recursive: true, force: true });
});

it.each(["normal", "401"] as const)(
  "audit-write failure leaves the %s provider outcome unchanged and warns without content",
  async (scenario) => {
    // File-in-place-of-directory is reliably unwritable, even for root in CI.
    writeFileSync(
      join(config.extensionRoot, ".audit"),
      "SYNTHETIC-PRIVATE-FILE",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    upstream = await startFakeUpstream([scenario]);
    claude = installFakeClaude(upstream.url);
    const result = await streamViaCli(model, {
      messages: [
        { role: "user", content: "SYNTHETIC-PRIVATE-PROMPT", timestamp: 1 },
      ],
    }).result();
    expect(result.stopReason).toBe(scenario === "normal" ? "stop" : "error");
    if (scenario === "normal")
      expect(JSON.stringify(result.content)).toContain(NORMAL_TEXT);
    expect(upstream.requests).toHaveLength(1);
    const warnings = () =>
      JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
    await vi.waitFor(() =>
      expect(warnings()).toMatch(/audit.*(?:fail|unable|could not)/i),
    );
    expect(warnings()).not.toContain(config.extensionRoot);
    expect(warnings()).not.toMatch(
      /SYNTHETIC-PRIVATE|fake-oauth-token|ENOTDIR/,
    );
    expect(readdirSync(config.extensionRoot)).not.toContain(".audit-fallback");
  },
);
