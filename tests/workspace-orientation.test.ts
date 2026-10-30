import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
  type FakeClaude,
  type FakeUpstream,
} from "./harness";

// The CLI runs in a private temp directory; Pi's tools run in the Pi workspace.
// These tests use distinct synthetic paths for the two and assert on the request
// the upstream receives, not on how a model would phrase its answer.

let sandbox: string;
let claude: FakeClaude | undefined;
let upstream: FakeUpstream | undefined;

beforeEach(() => {
  vi.resetModules();
  sandbox = mkdtempSync(join(tmpdir(), "pi-workspace-"));
  const home = join(sandbox, "home");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("TMPDIR", join(sandbox, "cli-tmp"));
  mkdirSync(join(sandbox, "cli-tmp"));
  vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_API_KEY_FALLBACK", "0");
  vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_TIMEOUT_MS", "5000");
  vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_SESSION_MODE", "replay");
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

type Body = { system: string; fake_cwd: string; fake_args: string[] };

/** Returns a function that sends one request through the provider and returns the upstream body. */
async function startProvider() {
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
  const model = {
    ...config.models![0],
    provider,
    api: config.api!,
    baseUrl: config.baseUrl!,
  } as Model<Api>;
  // Pi 1.x stream options carry no cwd; the workspace travels in the transcript.
  return async (messages: unknown[]): Promise<Body> => {
    const before = upstream!.requests.length;
    const stream = config.streamSimple!(
      model,
      { messages } as never,
      {} as never,
    );
    for await (const _ of stream);
    expect(upstream!.requests).toHaveLength(before + 1);
    return upstream!.requests[before].body as Body;
  };
}

const withCwdSection = (cwd: string) => [
  {
    role: "system",
    content: "BASE-PROMPT-4301",
    sections: { cwd: `Current working directory: ${cwd}` },
    timestamp: 0,
  },
  { role: "user", content: "Where am I?", timestamp: 1 },
];

it("tells Claude the Pi workspace while the CLI stays in its private temp directory", async () => {
  const send = await startProvider();
  const project = join(sandbox, "project-alpha");
  const body = await send(withCwdSection(project));

  expect(body.system).toContain(project);
  // The CLI ran in its own temp dir, not in the project or the host cwd
  expect(body.fake_cwd).toContain("pi-claude-subscription-");
  expect(body.fake_cwd.startsWith(project)).toBe(false);
  expect(body.fake_cwd).not.toBe(process.cwd());
  // The temp dir is not offered to the model as a workspace
  expect(body.system).not.toContain(body.fake_cwd);
  // Isolation and Pi-owned tools are preserved
  expect(body.fake_args).toContain("--tools");
});

it("forwards the session workspace for SDK embedding, where the host cwd differs", async () => {
  const send = await startProvider();
  const project = join(sandbox, "sdk-project");
  // Pi 1.x carries the session cwd only in the system message's cwd section
  expect(process.cwd()).not.toBe(project);
  const body = await send(withCwdSection(project));

  expect(body.system).toContain(project);
  expect(body.system).not.toContain(process.cwd());
  expect(body.system).not.toContain(body.fake_cwd);
  expect(body.fake_cwd).not.toBe(project);
});

it("drops the old workspace once Pi's workspace changes", async () => {
  const send = await startProvider();
  const first = join(sandbox, "project-first");
  const second = join(sandbox, "project-second");

  const one = await send(withCwdSection(first));
  expect(one.system).toContain(first);

  const two = await send(withCwdSection(second));
  expect(two.system).toContain(second);
  expect(two.system).not.toContain(first);
  expect(two.fake_cwd).not.toBe(second);
  expect(two.system).not.toContain(two.fake_cwd);
});
