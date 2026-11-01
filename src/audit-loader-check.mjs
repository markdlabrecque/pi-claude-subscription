#!/usr/bin/env node
// Run explicitly with Node to record loader failures before the extension exists.
// This calls only the SDK loader, never a model or provider stream.
import process from "node:process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sink from "./audit-sink.cjs";

if (["1", "true"].includes(process.env.PI_CLAUDE_SUBSCRIPTION_AUDIT)) {
  const extensionRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const audit = sink.createAuditSink({ extensionRoot, env: process.env });
  let extensionVersion = null;
  try {
    extensionVersion = JSON.parse(
      readFileSync(join(extensionRoot, "package.json"), "utf8"),
    ).version;
  } catch {
    /* Unknown. */
  }
  const record = {
    event: "extension_load",
    requestId: randomUUID(),
    outcome: "failure",
    reason: "sdk_import_error",
    versions: { extension: extensionVersion, pi: null, cli: null },
  };
  let workspace;
  // SDK/extension diagnostics can contain raw loader paths and exceptions.
  // This standalone command records categories instead, even if a factory logs.
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  const discard = (_chunk, encoding, callback) => {
    const done = typeof encoding === "function" ? encoding : callback;
    done?.();
    return true;
  };
  process.stdout.write = discard;
  process.stderr.write = discard;
  try {
    const sdk = await import("@earendil-works/pi-coding-agent");
    record.versions.pi = sdk.VERSION ?? null;
    record.reason = "sdk_load_error";
    // Exclude project/global auto-discovered extensions from this check.
    workspace = mkdtempSync(join(tmpdir(), "pi-audit-loader-"));
    const result = await sdk.discoverAndLoadExtensions(
      [extensionRoot],
      workspace,
      join(workspace, "agent"),
    );
    const registered = result.runtime?.pendingProviderRegistrations?.some(
      (p) => p.name === "pi-claude-subscription",
    );
    if (result.errors.length) record.reason = "loader_errors";
    else if (result.extensions.length && registered) {
      record.outcome = "success";
      record.reason = "registered";
    } else {
      record.outcome = "skipped";
      record.reason = "not_loaded";
    }
  } catch {
    // Never print or serialize the SDK exception, which may include paths/content.
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    if (workspace) {
      try {
        rmSync(workspace, { recursive: true, force: true });
      } catch {
        /* No raw errors. */
      }
    }
    await audit.append(record);
  }
  if (record.outcome !== "success") process.exitCode = 1;
}
