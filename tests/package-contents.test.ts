import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");

function packedPaths(): string[] {
  const out = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: root, encoding: "utf8" },
  );
  const [pack] = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
  return pack.files.map((f) => f.path);
}

describe("published package contents", () => {
  it("does not keep the session dump in the working tree", () => {
    expect(
      existsSync(join(root, "2026-03-17-143653-pi-claude-cli-sessions.txt")),
    ).toBe(false);
  });

  it("packs only runtime files", () => {
    const paths = packedPaths();
    const allowed = (p: string) =>
      p === "package.json" ||
      p === "index.ts" ||
      p === "README.md" ||
      p === "LICENSE" ||
      p.startsWith("src/");
    expect(paths.filter((p) => !allowed(p))).toEqual([]);
  });

  it("packs the files the extension needs at runtime", () => {
    const paths = packedPaths();
    expect(paths).toEqual(
      expect.arrayContaining([
        "index.ts",
        "README.md",
        "LICENSE",
        "src/provider.ts",
        "src/mcp-schema-server.cjs",
      ]),
    );
  });
});
