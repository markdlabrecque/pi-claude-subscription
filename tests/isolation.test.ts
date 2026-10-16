import { describe, it, expect, afterEach, vi } from "vitest";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamViaCli } from "../src/provider";
import { writeMcpConfig } from "../src/mcp-config";
import {
  startFakeUpstream,
  installFakeClaude,
  type FakeUpstream,
  type FakeClaude,
  type Scenario,
} from "./harness";

const model: any = {
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  api: "anthropic-messages",
  provider: "pi-claude-subscription",
  reasoning: false,
  input: ["text"],
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  contextWindow: 200000,
  maxTokens: 8192,
};

const PI_PROMPT = "PI-SYSTEM-PROMPT-ONLY";
const MARKERS = ["MARKER-CLAUDE-MD", "MARKER-SKILL", "MARKER-HOOK"];
const PI_TOOLS = ["read", "write", "edit", "bash", "grep", "find"].map(
  (name) => ({
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
  }),
);

let upstream: FakeUpstream | undefined;
let claude: FakeClaude | undefined;
let home: string | undefined;
const savedHome = process.env.HOME;

afterEach(async () => {
  claude?.restore();
  await upstream?.close();
  if (home) rmSync(home, { recursive: true, force: true });
  process.env.HOME = savedHome;
  claude = upstream = home = undefined;
});

/** A HOME with a global CLAUDE.md, a skill and a UserPromptSubmit hook. */
function plantMarkers(): string {
  home = mkdtempSync(join(tmpdir(), "isolation-home-"));
  const dir = join(home, ".claude");
  mkdirSync(join(dir, "skills", "planted"), { recursive: true });
  writeFileSync(join(dir, "CLAUDE.md"), MARKERS[0]);
  writeFileSync(join(dir, "skills", "planted", "SKILL.md"), MARKERS[1]);
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: `echo ${MARKERS[2]}` }] },
        ],
      },
    }),
  );
  return home;
}

async function run(scenario: Scenario = "normal") {
  upstream = await startFakeUpstream([scenario]);
  claude = installFakeClaude(upstream.url);
  process.env.HOME = plantMarkers();
  const stream = streamViaCli(
    model,
    {
      systemPrompt: PI_PROMPT,
      messages: [{ role: "user", content: "Hi", timestamp: 1 }],
    },
    { mcpConfigPath: writeMcpConfig(PI_TOOLS) },
  );
  for await (const _ of stream);
  await stream.result();
  return upstream.requests[0]?.body as any;
}

describe("request isolation", () => {
  it("keeps host config out of the upstream request", async () => {
    const body = await run();
    const sent = JSON.stringify(body);

    for (const marker of MARKERS) expect(sent).not.toContain(marker);
    expect(sent).toContain(PI_PROMPT);
  });

  it("the planted markers do reach a CLI run without isolation", async () => {
    upstream = await startFakeUpstream();
    claude = installFakeClaude(upstream.url);
    const env = { ...process.env, HOME: plantMarkers() };
    const userMessage = { message: { role: "user", content: "Hi" } };
    const child = spawn("claude", [], { env });
    child.stdin.end(JSON.stringify(userMessage) + "\n");
    await new Promise((resolve) => child.on("close", resolve));

    const sent = JSON.stringify(upstream.requests[0].body);
    for (const marker of MARKERS) expect(sent).toContain(marker);
  });

  it("offers no built-in tools and replaces Claude Code's system prompt", async () => {
    const body = await run();

    expect(body.tools.map((t: any) => t.name).sort()).toEqual(
      PI_TOOLS.map((t) => `mcp__custom-tools__${t.name}`).sort(),
    );
    expect(body.system).not.toContain("You are Claude Code");
  });

  it.each<Scenario>(["normal", "401"])(
    "removes the private working directory (%s)",
    async (scenario) => {
      const body = await run(scenario);
      const cwd = body?.fake_cwd as string;

      expect(cwd).toBeTruthy();
      expect(cwd.startsWith(tmpdir())).toBe(true);
      await vi.waitFor(() => expect(existsSync(cwd)).toBe(false));
    },
  );
});
