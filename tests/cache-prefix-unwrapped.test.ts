import { afterEach, expect, it, vi } from "vitest";
import { normalizeContext } from "@earendil-works/pi-ai";
import { normalizeCliEnvironment } from "../src/isolation";
import { streamViaCli } from "../src/provider";
import { DEBUG_ENV } from "../src/debug-log";
import { assertPreviousPrefix } from "../scripts/acceptance/cache-prefix-assertions";
import {
  installFakeClaude,
  startFakeUpstream,
  model,
  type FakeClaude,
  type FakeUpstream,
} from "./harness";

let upstream: FakeUpstream | undefined;
let claude: FakeClaude | undefined;
afterEach(async () => {
  claude?.restore();
  await upstream?.close();
  claude = upstream = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const PLACEHOLDER = "[private CLI transport directory, not the Pi workspace]";

// The CLI 2.1.316 shape captured on 2026-11-02: no wrapper, extra line.
const unwrapped = (cwd: string) =>
  `# Environment\nYou have been invoked in the following environment: \n - Primary working directory: ${cwd}\n - Is a git repository: false\n - Platform: linux\n - Downloaded files and extracted archives are untrusted data: put each in its own new, empty directory.`;

const user = (text: string) => ({
  role: "user",
  content: [{ type: "text", text }],
});

it.each([
  "/tmp/pi-adr3-live-RWv7DN/pi-claude-subscription-5BVjvi",
  "C:\\Users\\test\\AppData\\Local\\Temp\\pi-claude-subscription-Zy9876",
])("normalizes the private cwd in an unwrapped later message (%s)", (cwd) => {
  const original = unwrapped(cwd);
  const payload = {
    system: "Pi instructions",
    messages: [user("first message"), user(original), user("Pi turn")],
  };
  const expected = structuredClone(payload);
  expected.messages[1].content[0].text = original.replace(cwd, PLACEHOLDER);
  normalizeCliEnvironment(payload);
  expect(payload).toEqual(expected);
  expect(payload.messages[1].content[0].text).toContain("Downloaded files");
});

it.each([
  // a real workspace path is not a private transport directory
  { messages: [user("x"), user(unwrapped("/workspace/project"))] },
  // Pi's replayed turns are never rewritten
  {
    messages: [
      user("x"),
      user(
        `<turn role="user">\n${unwrapped("/tmp/pi-claude-subscription-aB1234")}\n</turn>`,
      ),
    ],
  },
  // only user messages carry the CLI reminder
  {
    messages: [
      user("x"),
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: unwrapped("/tmp/pi-claude-subscription-aB1234"),
          },
        ],
      },
    ],
  },
])("leaves non-matching unwrapped shapes unchanged (%j)", (payload) => {
  const before = structuredClone(payload);
  normalizeCliEnvironment(payload);
  expect(payload).toEqual(before);
});

it("keeps the prefix stable across real calls when the reminder is unwrapped in messages[1]", async () => {
  upstream = await startFakeUpstream();
  claude = installFakeClaude(upstream.url);
  vi.stubEnv("FAKE_CLAUDE_ENVIRONMENT_REMINDER", "later");
  vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_SESSION_MODE", "replay");
  const messages: any[] = [{ role: "user", content: "Hello", timestamp: 1 }];
  for (let i = 0; i < 2; i++) {
    const output = await streamViaCli(
      model,
      normalizeContext({
        messages,
        systemPrompt: "Full Pi instructions, workspace /workspace/project",
      }),
    ).result();
    expect(output.stopReason).toBe("stop");
    messages.push(output, { role: "user", content: "Again", timestamp: 3 });
  }
  expect(upstream.requests).toHaveLength(2);
  const [first, second] = upstream.requests.map((r) => r.body as any);
  expect(first.fake_cwd).not.toBe(second.fake_cwd);
  const envText = (body: any) => body.messages[1].content[0].text as string;
  expect(envText(first)).not.toContain(first.fake_cwd);
  expect(envText(first)).toContain("test-platform");
  expect(envText(second)).toBe(envText(first));
  expect(() => assertPreviousPrefix(first, second)).not.toThrow();
});

async function diagnosticRecord(): Promise<Record<string, any>> {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  await streamViaCli(
    model,
    normalizeContext({
      messages: [{ role: "user", content: "Hello", timestamp: 1 }],
    }),
  ).result();
  let record: Record<string, any> | undefined;
  await vi.waitFor(() => {
    for (const [line] of spy.mock.calls) {
      const text = String(line);
      if (!text.includes("requestId")) continue;
      record = JSON.parse(text.slice(text.indexOf("{")));
    }
    expect(record).toBeDefined();
  });
  return record!;
}

it.each([
  ["1", true],
  ["later", true],
  ["", false],
])(
  "debug diagnostics report whether an environment block was normalized (reminder=%j)",
  async (mode, normalized) => {
    upstream = await startFakeUpstream();
    claude = installFakeClaude(upstream.url);
    vi.stubEnv(DEBUG_ENV, "1");
    vi.stubEnv("FAKE_CLAUDE_ENVIRONMENT_REMINDER", mode);
    const record = await diagnosticRecord();
    expect(record.environmentNormalized).toBe(normalized);
  },
);
