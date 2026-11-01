import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import {
  installFakeClaude,
  startFakeUpstream,
  writeSession,
  type FakeClaude,
  type FakeUpstream,
} from "./harness";

// Modern Pi sends its instructions as transcript system messages, not as
// Context.systemPrompt. These tests drive the registered provider callback with
// real transcript shapes and assert on the system prompt the upstream receives.

const GLOBAL_PATH = "~/.pi/agent/AGENTS.md";
const SKILL_PATH = ".pi/skills/example/SKILL.md";
const FILE_MARKERS = ["FILE-AGENTS-WORKSPACE-8462", "FILE-AGENTS-GLOBAL-8462"];

let sandbox: string;
let claude: FakeClaude | undefined;
let upstream: FakeUpstream | undefined;

beforeEach(() => {
  vi.resetModules();
  sandbox = mkdtempSync(join(tmpdir(), "pi-instructions-"));
  const home = join(sandbox, "home");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  mkdirSync(join(sandbox, "workspace"));
  // Files an extension-side loader would pick up. Pi's own text is authoritative.
  writeFileSync(join(sandbox, "workspace", "AGENTS.md"), FILE_MARKERS[0]);
  writeFileSync(join(home, ".pi", "agent", "AGENTS.md"), FILE_MARKERS[1]);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("TMPDIR", sandbox);
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

const assistant = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  timestamp: 2,
});

/** Send `messages` through the registered provider; return the upstream system prompt. */
async function systemPromptFor(
  messages: unknown[],
  mode: "replay" | "resume" = "replay",
) {
  vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_SESSION_MODE", mode);
  upstream = await startFakeUpstream();
  claude = installFakeClaude(upstream.url);
  const registerProvider =
    vi.fn<(name: string, config: ProviderConfig) => void>();
  const { default: extension } = await import("../index");
  extension({
    registerProvider,
    on: vi.fn(),
    getAllTools: () => [],
  } as unknown as ExtensionAPI);
  const [provider, config] = registerProvider.mock.calls[0];
  const registered = config.models![0];
  const model = {
    ...registered,
    provider,
    api: config.api!,
    baseUrl: config.baseUrl!,
  } as Model<Api>;
  if (mode === "resume")
    writeSession(process.env.HOME!, "pi-session-1", "{}\n");
  const stream = config.streamSimple!(
    model,
    { messages } as never,
    {
      cwd: join(sandbox, "workspace"),
      sessionId: "pi-session-1",
    } as never,
  );
  for await (const _ of stream);
  expect(upstream.requests).toHaveLength(1);
  const body = upstream.requests[0].body as {
    system: string;
    fake_args: string[];
    messages: unknown[];
  };
  return body;
}

const count = (text: string, part: string) => text.split(part).length - 1;

it("sends the leading system message to Claude intact: rules, cwd, skills and exact paths, once", async () => {
  const { system } = await systemPromptFor([
    {
      role: "system",
      content: "BASE-PROMPT-8462",
      sections: {
        rules: `RULES-8462: global ${GLOBAL_PATH} and project rules combined`,
        cwd: "CWD-8462: /work/example",
        skills: `SKILLS-8462: see ${SKILL_PATH}`,
      },
      timestamp: 0,
    },
    { role: "user", content: "Hello", timestamp: 1 },
  ]);

  for (const part of [
    "BASE-PROMPT-8462",
    `RULES-8462: global ${GLOBAL_PATH} and project rules combined`,
    "CWD-8462: /work/example",
    `SKILLS-8462: see ${SKILL_PATH}`,
  ])
    expect(count(system, part), part).toBe(1);

  // Paths are not rewritten for Claude, and files are not loaded on the side
  expect(system).not.toContain("~/.claude");
  expect(system).not.toContain(".claude/");
  for (const marker of FILE_MARKERS) expect(system).not.toContain(marker);
});

it.each(["replay", "resume"] as const)(
  "applies system-message changes made mid-conversation in %s mode",
  async (mode) => {
    const { system, fake_args } = await systemPromptFor(
      [
        {
          role: "system",
          content: "BASE-PROMPT-8462",
          sections: {
            rules: "RULES-OLD-8462",
            skills: "SKILLS-REMOVED-8462",
            cwd: "CWD-KEPT-8462",
          },
          timestamp: 0,
        },
        { role: "user", content: "First", timestamp: 1 },
        assistant("Done"),
        {
          role: "system",
          content: "LATER-INSTRUCTION-8462",
          sections: { rules: "RULES-NEW-8462", skills: null },
          timestamp: 3,
        },
        { role: "user", content: "Second", timestamp: 4 },
      ],
      mode,
    );

    expect(fake_args.includes("--resume")).toBe(mode === "resume");
    for (const part of [
      "BASE-PROMPT-8462",
      "LATER-INSTRUCTION-8462",
      "RULES-NEW-8462",
      "CWD-KEPT-8462",
    ])
      expect(count(system, part), part).toBe(1);
    expect(system).not.toContain("RULES-OLD-8462");
    expect(system).not.toContain("SKILLS-REMOVED-8462");
  },
);

it("keeps replay guidance out of Pi's instructions and system turns out of the replayed history", async () => {
  const { system, messages } = await systemPromptFor([
    {
      role: "system",
      content: "BASE-PROMPT-8462",
      timestamp: 0,
    },
    { role: "user", content: "First", timestamp: 1 },
    assistant("Done"),
    { role: "user", content: "Second", timestamp: 4 },
  ]);

  expect(system.startsWith("BASE-PROMPT-8462")).toBe(true);
  expect(system).toContain("<turn> blocks");
  expect(JSON.stringify(messages)).not.toContain("BASE-PROMPT-8462");
});
