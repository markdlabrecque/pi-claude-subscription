import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeContext,
  Type,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import {
  installFakeClaude,
  startFakeUpstream,
  type FakeClaude,
  type FakeUpstream,
  type Scenario,
} from "./harness";

// Isolation through the supported Pi 1.x entry point: the registered provider
// callback, fed a normalized context whose instructions are transcript system
// messages and whose tools come from Pi's offered set.

const PI_INSTRUCTIONS = "PI-1X-INSTRUCTIONS-4417";
const MARKERS = [
  "MARKER-CLAUDE-MD-4417",
  "MARKER-SKILL-4417",
  "MARKER-HOOK-4417",
];

let sandbox: string;
let claude: FakeClaude | undefined;
let upstream: FakeUpstream | undefined;

beforeEach(() => {
  vi.resetModules();
  sandbox = mkdtempSync(join(tmpdir(), "isolation-registered-"));
  const home = join(sandbox, "home");
  const dir = join(home, ".claude");
  mkdirSync(join(dir, "skills", "planted"), { recursive: true });
  mkdirSync(join(sandbox, "workspace", ".claude"), { recursive: true });
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
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  // A private TMPDIR, so only this test's temp directories are counted
  const tmp = join(sandbox, "tmp");
  mkdirSync(tmp);
  vi.stubEnv("TMPDIR", tmp);
  vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_API_KEY_FALLBACK", "0");
  vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_TIMEOUT_MS", "5000");
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "FAKE_CLAUDE_NOT_LOGGED_IN",
    "FAKE_CLAUDE_FAIL_AFTER_REQUEST",
  ])
    vi.stubEnv(key, undefined);
});

afterEach(async () => {
  claude?.restore();
  await upstream?.close();
  vi.unstubAllEnvs();
  rmSync(sandbox, { recursive: true, force: true });
  claude = upstream = undefined;
});

async function runRegistered(
  tools: { name: string; description: string; parameters: unknown }[],
  scenario: Scenario = "normal",
) {
  upstream = await startFakeUpstream([scenario]);
  claude = installFakeClaude(upstream.url);
  const registerProvider =
    vi.fn<(name: string, config: ProviderConfig) => void>();
  const { default: extension } = await import("../index");
  extension({
    registerProvider,
    on: vi.fn(),
    getAllTools: () => tools,
  } as unknown as ExtensionAPI);
  const [provider, config] = registerProvider.mock.calls[0];
  const model = {
    ...(config.models![0] as object),
    provider,
    api: config.api!,
    baseUrl: config.baseUrl!,
  } as Model<Api>;
  const context = normalizeContext({
    messages: [
      { role: "system", content: PI_INSTRUCTIONS, timestamp: 0 },
      { role: "user", content: "Hi", timestamp: 1 },
    ],
    ...(tools.length ? { tools } : {}),
  } as never);
  const stream = config.streamSimple!(model, context, {
    cwd: join(sandbox, "workspace"),
    sessionId: "pi-session-1",
  } as never);
  for await (const _ of stream);
  await stream.result();
  return upstream.requests[0]?.body as {
    system: string;
    tools: { name: string }[];
    fake_cwd: string;
    fake_args: string[];
    messages: unknown;
  };
}

it("keeps host config out of the request and lets Pi's instructions replace Claude Code's", async () => {
  const body = await runRegistered([]);

  const sent = JSON.stringify(body);
  for (const marker of MARKERS) expect(sent).not.toContain(marker);
  expect(body.system).toContain(PI_INSTRUCTIONS);
  expect(body.system).not.toContain("You are Claude Code");
});

it("offers only Pi's tools, never built-ins", async () => {
  const read = {
    name: "read",
    description: "Read",
    parameters: Type.Object({ path: Type.String() }),
  };
  const body = await runRegistered([read]);

  expect(body.tools.map((t) => t.name)).toEqual(["mcp__custom-tools__read"]);
});

it("runs from a private directory that never reaches the project, and never uses the flags that bypass isolation", async () => {
  const body = await runRegistered([]);

  expect(body.fake_cwd.startsWith(join(sandbox, "workspace"))).toBe(false);
  for (const flag of ["--settings", "--plugin-dir", "--agents"])
    expect(body.fake_args).not.toContain(flag);
});

it.each<Scenario>(["normal", "401", "429"])(
  "leaves no temp files behind (%s)",
  async (scenario) => {
    const body = await runRegistered([], scenario);

    await vi.waitFor(() => {
      expect(existsSync(body.fake_cwd)).toBe(false);
      expect(
        readdirSync(join(sandbox, "tmp")).filter((d) =>
          d.startsWith("pi-claude-"),
        ),
      ).toEqual([]);
    });
  },
);
