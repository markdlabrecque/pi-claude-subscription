import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFakeClaude, type FakeClaude } from "./harness";
import manifest from "../package.json";
import lockfile from "../package-lock.json";

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

/** Install the actual tarball and runtime dependencies, without peer downloads. */
function packAndInstall(dest: string): string {
  const out = execFileSync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", dest],
    { cwd: root, encoding: "utf8" },
  );
  const [{ filename }] = JSON.parse(out) as Array<{ filename: string }>;
  // A clean npm ci caches locked tarballs, not necessarily registry metadata.
  // Give this install the same runtime resolutions so offline mode never needs
  // to resolve the package's dependency ranges against a registry packument.
  const fixture = {
    name: "pi-loader-fixture",
    version: "1.0.0",
    dependencies: { [manifest.name]: `file:./${filename}` },
  };
  const { name, version, dependencies, peerDependencies, engines } = manifest;
  writeFileSync(join(dest, "package.json"), JSON.stringify(fixture));
  writeFileSync(
    join(dest, "package-lock.json"),
    JSON.stringify({
      name: fixture.name,
      version: fixture.version,
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": fixture,
        ...Object.fromEntries(
          Object.entries(lockfile.packages).filter(
            ([path, entry]) => path && !("dev" in entry && entry.dev),
          ),
        ),
        [`node_modules/${name}`]: {
          name,
          version,
          resolved: `file:./${filename}`,
          dependencies,
          peerDependencies,
          engines,
        },
      },
    }),
  );
  execFileSync(
    "npm",
    [
      "ci",
      "--offline",
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: dest, encoding: "utf8" },
  );
  return join(dest, "node_modules", "pi-claude-subscription");
}

it.each(
  ["packed tarball", "Git/local checkout"].flatMap((source) =>
    ["0", "1"].map((fallback) => ({ source, fallback })),
  ),
)(
  "loads in Pi 1.4.0 from the $source with API fallback=$fallback and registers its provider",
  async ({ source, fallback }) => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-installed-")));
    const pkg = source === "packed tarball" ? packAndInstall(dir) : root;
    const cwd = join(dir, "cwd");
    mkdirSync(cwd);
    // Startup probes only; no request is made.
    claude = installFakeClaude("http://127.0.0.1:9");

    // A fresh Node process uses the installed SDK, not Vitest module transforms.
    // It also keeps Jiti's source maps separate from V8 unit-test coverage.
    const loaded = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
const [pkg, cwd, agent] = process.argv.slice(1);
const { extensions, errors, runtime } = await discoverAndLoadExtensions([pkg], cwd, agent);
console.log(JSON.stringify({
  errors,
  entries: extensions.map(e => e.resolvedPath),
  providers: runtime.pendingProviderRegistrations.map(p => ({
    name: p.name, modelCount: p.config.models?.length ?? 0,
    hasStream: typeof p.config.streamSimple === "function",
  })),
}));
`,
          pkg,
          cwd,
          join(dir, "no-agent-dir"),
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...process.env,
            PI_CLAUDE_SUBSCRIPTION_API_KEY_FALLBACK: fallback,
            PI_CLAUDE_SUBSCRIPTION_AUDIT: "0",
          },
        },
      ),
    );

    expect(loaded.errors).toEqual([]);
    expect(loaded.entries).toEqual([join(pkg, "index.ts")]);
    expect(loaded.providers).toEqual([
      {
        name: "pi-claude-subscription",
        modelCount: expect.any(Number),
        hasStream: true,
      },
    ]);
    expect(loaded.providers[0].modelCount).toBeGreaterThan(0);

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
  },
  60_000,
);
