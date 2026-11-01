import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { installFakeClaude, type FakeClaude } from "./harness";

// Tested against Pi 1.4.0 (@earendil-works/pi-coding-agent@1.4.0, the pinned
// devDependency). Recorded in docs/pi-1x-verification.md.
const root = join(__dirname, "..");

let dir: string | undefined;
let claude: FakeClaude | undefined;

afterEach(() => {
  claude?.restore();
  if (dir) rmSync(dir, { recursive: true, force: true });
  claude = dir = undefined;
});

/** Pack the repo into a tarball and extract it, as `npm install` would. */
function packAndExtract(dest: string): string {
  const out = execFileSync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", dest],
    { cwd: root, encoding: "utf8" },
  );
  const [{ filename }] = JSON.parse(out) as Array<{ filename: string }>;
  execFileSync("tar", ["-xzf", filename], { cwd: dest });
  const pkg = join(dest, "package");
  // Stand in for the installed dependencies and Pi peers.
  const modules = join(root, "node_modules");
  symlinkSync(modules, join(pkg, "node_modules"), "junction");
  return pkg;
}

// Skipped: Pi 1.4.0 cannot resolve @earendil-works/pi-ai/providers/anthropic or
// /api/anthropic-messages through its extension loader. Re-enable with that fix.
it.skip("loads in Pi 1.4.0 from the packed tarball and registers its provider", async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-packed-")));
  const pkg = packAndExtract(dir);
  const cwd = join(dir, "cwd");
  mkdirSync(cwd);
  // Startup probes only; no request is made.
  claude = installFakeClaude("http://127.0.0.1:9");

  const { extensions, errors, runtime } = await discoverAndLoadExtensions(
    [pkg],
    cwd,
    join(dir, "no-agent-dir"),
  );

  expect(errors).toEqual([]);
  const entry = join(pkg, "index.ts");
  expect(extensions.map((e) => e.resolvedPath)).toEqual([entry]);
  const providers = runtime.pendingProviderRegistrations;
  expect(providers.map((p) => p.name)).toEqual(["pi-claude-subscription"]);
  expect(providers[0].config.models?.length).toBeGreaterThan(0);

  // The schema-only MCP server ships next to the packed mcp-config module.
  const mcpConfig = join(pkg, "src", "mcp-config.ts");
  const { writeMcpConfig, removeMcpConfig } = await import(mcpConfig);
  const configPath: string = writeMcpConfig([
    { name: "t", description: "t", inputSchema: { type: "object" } },
  ]);
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const serverPath = config.mcpServers["custom-tools"].args[0];
    expect(serverPath).toBe(join(pkg, "src", "mcp-schema-server.cjs"));
    expect(existsSync(serverPath)).toBe(true);
  } finally {
    removeMcpConfig(configPath);
  }
}, 60_000);
