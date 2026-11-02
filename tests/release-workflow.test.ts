import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parse } from "yaml";

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};
type Job = {
  needs?: string;
  permissions?: Record<string, string>;
  steps: Step[];
};
type Workflow = {
  on: { push: { tags: string[] } };
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};

const root = join(__dirname, "..");
const source = readFileSync(
  join(root, ".github/workflows/publish.yml"),
  "utf8",
);
const workflow = parse(source) as Workflow;
const { version } = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
) as { version: string };

describe("GitHub-only release workflow", () => {
  it("runs on version tags and gates releases on offline checks", () => {
    expect(workflow.on).toEqual({ push: { tags: ["v*"] } });
    expect(workflow.jobs.release.needs).toBe("validate");
    expect(workflow.jobs.release).not.toHaveProperty("if");
    const steps = workflow.jobs.validate.steps;
    expect(steps.map((step) => step.run).filter(Boolean)).toEqual([
      expect.stringContaining("TAG_VERSION="),
      "npm ci",
      "npm run check-style",
      "npm run typecheck",
      "npm test",
    ]);
    expect(steps.every((step) => !("continue-on-error" in step))).toBe(true);
    expect(workflow.jobs.validate).not.toHaveProperty("continue-on-error");
  });

  it("grants write access only to GitHub release creation", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.validate.permissions).toBeUndefined();
    expect(workflow.jobs.release.permissions).toEqual({ contents: "write" });
    expect(workflow.jobs.release.steps).toEqual([
      {
        uses: "softprops/action-gh-release@v2",
        with: { generate_release_notes: true },
      },
    ]);
    expect(source).not.toMatch(
      /npm publish|registry-url|NODE_AUTH_TOKEN|NPM_TOKEN|id-token|secrets\./,
    );
  });

  // Execute only the version-check shell, never installation or release actions.
  it.each([
    { tag: `v${version}`, status: 0 },
    { tag: "v999.999.999", status: 1 },
  ])(
    "validates $tag against package.json without credentials",
    ({ tag, status }) => {
      const script = workflow.jobs.validate.steps.find(
        (step) => step.name === "Validate version match",
      )?.run;
      expect(script).toBeTypeOf("string");
      const result = spawnSync("bash", ["-e", "-c", script!], {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          GITHUB_REF: `refs/tags/${tag}`,
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(status);
      if (status !== 0) {
        expect(result.stdout).toContain("does not match package.json version");
      }
    },
  );
});
