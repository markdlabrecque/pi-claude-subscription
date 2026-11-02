/**
 * Stands in for Pi in its own Node process, so an error that escapes a
 * subprocess event handler ends this process the way it would end Pi.
 *
 * HOST_WIRING=direct attaches the isolation cleanup straight to the process
 * events, as the installed 67d8cc8 build does; HOST_WIRING=spawn goes through
 * spawnClaude. Removing a request temp directory fails with ENOTEMPTY the
 * first HOST_RM_FAILURES times (default: always).
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";

const realRmSync = fs.rmSync;
let failures = Number(process.env.HOST_RM_FAILURES ?? "Infinity");
(fs as { rmSync: typeof fs.rmSync }).rmSync = (path, options) => {
  const owned = basename(String(path)).startsWith("pi-claude-subscription-");
  if (owned && failures > 0) {
    failures--;
    const err: NodeJS.ErrnoException = new Error(
      `ENOTEMPTY, Directory not empty: ${path}`,
    );
    err.code = "ENOTEMPTY";
    throw err;
  }
  return realRmSync(path, options);
};
// The sources import rmSync by name, so update the ESM bindings too
syncBuiltinESMExports();

const { createIsolation } = await import("../../src/isolation");
const { spawnClaude, forceKillProcess, observeProcessCleanup } =
  await import("../../src/process-manager");

if (process.env.HOST_WIRING === "direct") {
  const isolation = createIsolation("host");
  const proc = spawn(process.execPath, ["-e", ""], { cwd: isolation.cwd });
  proc.once("close", isolation.cleanup);
  proc.once("error", isolation.cleanup);
  // Registered after cleanup, so it only runs if cleanup did not throw
  await new Promise((resolve) => proc.once("close", resolve));
  process.stdout.write(JSON.stringify({ closed: true }));
} else {
  const proc = spawnClaude("claude-sonnet-4-5");
  forceKillProcess(proc);
  const cleanup = await observeProcessCleanup(proc);
  process.stdout.write(JSON.stringify({ closed: true, cleanup }));
}
