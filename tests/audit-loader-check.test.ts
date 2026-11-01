import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Run the shipped mjs with node, outside Vitest's TS module loader. Its peer
// SDK is a synthetic installed package. No extension factory or model runs.
const repo = join(__dirname, "..");
const secret = "SYNTHETIC-LOADER-RAW-ERROR-ACCOUNT-PATH";
let sandbox: string;
let pkg: string;
beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "audit-loader-")));
  pkg = join(sandbox, "extension");
  mkdirSync(pkg);
});
afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

function install(
  mode: "success" | "errors" | "empty" | "import-reject" | "load-reject",
) {
  const entry = join(repo, "src", "audit-loader-check.mjs");
  expect(
    existsSync(entry),
    "required packaged src/audit-loader-check.mjs standalone entry",
  ).toBe(true);
  cpSync(join(repo, "src"), join(pkg, "src"), { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "pi-claude-subscription",
      version: "0.4.0",
      pi: { extensions: ["index.ts"] },
    }),
  );
  // A loader-check must delegate to the SDK, not import the extension directly.
  writeFileSync(
    join(pkg, "index.ts"),
    `throw new Error(${JSON.stringify(secret)});`,
  );
  const sdk = join(pkg, "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(sdk, { recursive: true });
  writeFileSync(
    join(sdk, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "1.4.0",
      type: "module",
      exports: "./index.mjs",
    }),
  );
  writeFileSync(
    join(sdk, "index.mjs"),
    `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync(${JSON.stringify(join(sandbox, "sdk-imported"))}, 'yes');
${mode === "import-reject" ? `throw new Error(${JSON.stringify(secret)});` : ""}
export async function discoverAndLoadExtensions(paths, cwd, agentDir) {
  writeFileSync(${JSON.stringify(join(sandbox, "sdk-called.json"))}, JSON.stringify({ paths, cwd, agentDir }));
  ${mode === "load-reject" ? `throw new Error(${JSON.stringify(secret)});` : ""}
  return {
    extensions: ${mode === "success" ? "[{ resolvedPath: join(paths[0], 'index.ts') }]" : "[]"},
    errors: ${mode === "errors" ? `[{ path: join(paths[0], 'index.ts'), error: ${JSON.stringify(secret)} }]` : "[]"},
    runtime: { pendingProviderRegistrations: ${mode === "success" ? "[{ name: 'pi-claude-subscription', config: {} }]" : "[]"} }
  };
}
`,
  );
  return join(pkg, "src", "audit-loader-check.mjs");
}
function run(entry: string, enabled = true) {
  // Explicit, synthetic environment. No inherited account credentials or config.
  const result = spawnSync(process.execPath, [entry], {
    cwd: sandbox,
    encoding: "utf8",
    timeout: 10000,
    env: {
      PATH: process.env.PATH,
      HOME: sandbox,
      TMPDIR: sandbox,
      PI_CLAUDE_SUBSCRIPTION_AUDIT: enabled ? "1" : "0",
    },
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.stdout + result.stderr).not.toContain(secret);
  expect(result.stdout + result.stderr).not.toContain(sandbox);
  return result;
}
function records() {
  const auditDir = join(pkg, ".audit");
  expect(
    existsSync(auditDir),
    "standalone loader must persist its own audit evidence",
  ).toBe(true);
  return readdirSync(auditDir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) =>
      readFileSync(join(auditDir, f), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    );
}

describe("packaged opt-in loader check", () => {
  it("ships the separately executable loader check in the npm package", () => {
    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: repo,
        encoding: "utf8",
      }),
    );
    expect(
      packed[0].files.map((file: { path: string }) => file.path),
    ).toContain("src/audit-loader-check.mjs");
  });
  it("is off without opt-in and does not import the SDK or create audit files", () => {
    const entry = install("success");
    run(entry, false);
    expect(existsSync(join(sandbox, "sdk-imported"))).toBe(false);
    expect(existsSync(join(pkg, ".audit"))).toBe(false);
  });

  it.each([
    ["success", "success"],
    ["errors", "failure"],
    ["empty", "skipped"],
    ["import-reject", "failure"],
    ["load-reject", "failure"],
  ] as const)(
    "records sanitized %s from the installed SDK as %s",
    (mode, outcome) => {
      run(install(mode));
      const rows = records();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        event: "extension_load",
        schemaVersion: 1,
        outcome,
      });
      expect(rows[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      expect(rows[0].requestId).toEqual(expect.any(String));
      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(sandbox);
      expect(serialized).not.toMatch(
        /"event":"request_terminal"|"outcome":"success".*"route"/,
      );
      if (mode !== "import-reject") {
        const call = JSON.parse(
          readFileSync(join(sandbox, "sdk-called.json"), "utf8"),
        );
        expect(call.paths).toEqual([pkg]);
      }
      if (mode === "import-reject")
        expect(rows[0].reason).toBe("sdk_import_error");
      if (mode === "load-reject") expect(rows[0].reason).toBe("sdk_load_error");
    },
  );
});
