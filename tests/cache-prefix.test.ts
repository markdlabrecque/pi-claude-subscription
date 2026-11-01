import { afterEach, expect, it, vi } from "vitest";
import { normalizeContext } from "@earendil-works/pi-ai";
import { normalizeCliEnvironment } from "../src/isolation";
import { streamViaCli } from "../src/provider";
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
});

const reminder = (cwd: string) =>
  `<system-reminder>\n# Environment\nYou have been invoked in the following environment: \n - Primary working directory: ${cwd}\n - Platform: test-platform\n</system-reminder>`;

it.each([
  "/tmp/pi-claude-subscription-aB1234",
  "C:\\Users\\test\\AppData\\Local\\Temp\\pi-claude-subscription-Zy9876",
])(
  "normalizes only the private cwd in the leading CLI reminder (%s)",
  (cwd) => {
    const original = reminder(cwd);
    const payload = {
      system: original,
      tools: [{ name: "read", description: original }],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: original,
              cache_control: { type: "ephemeral" },
            },
            { type: "text", text: `<turn role="user">\n${original}\n</turn>` },
          ],
        },
      ],
    };
    const expected = structuredClone(payload);
    expected.messages[0].content[0].text = original.replace(
      cwd,
      "[private CLI transport directory, not the Pi workspace]",
    );
    normalizeCliEnvironment(payload);
    expect(payload).toEqual(expected);
  },
);

it.each([
  null,
  {},
  { messages: [] },
  { messages: [{ role: "user", content: "hello" }] },
  {
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: reminder("/tmp/pi-claude-subscription-aB1234"),
          },
        ],
      },
    ],
  },
  {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: reminder("/workspace/project") }],
      },
    ],
  },
  {
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `<turn role="user">\n${reminder("/tmp/pi-claude-subscription-aB1234")}\n</turn>`,
          },
        ],
      },
    ],
  },
])("leaves other payload shapes and Pi content unchanged (%j)", (payload) => {
  const before = structuredClone(payload);
  normalizeCliEnvironment(payload);
  expect(payload).toEqual(before);
});

it("keeps the prefix stable across real provider calls with fresh isolated directories", async () => {
  upstream = await startFakeUpstream();
  claude = installFakeClaude(upstream.url);
  vi.stubEnv("FAKE_CLAUDE_ENVIRONMENT_REMINDER", "1");
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
  expect(second.system).toBe(first.system);
  expect(
    second.messages[0].content.slice(0, first.messages[0].content.length),
  ).toEqual(first.messages[0].content);
  expect(first.messages[0].content[0].text).not.toContain(first.fake_cwd);
  expect(first.messages[0].content[0].text).toContain("test-platform");
});

it("normalizes before the caller's payload hook and honors its replacement", async () => {
  upstream = await startFakeUpstream();
  claude = installFakeClaude(upstream.url);
  vi.stubEnv("FAKE_CLAUDE_ENVIRONMENT_REMINDER", "1");
  const onPayload = vi.fn((payload: any) => {
    expect(payload.messages[0].content[0].text).toContain(
      "[private CLI transport directory, not the Pi workspace]",
    );
    return { ...payload, max_tokens: 17 };
  });
  await streamViaCli(
    model,
    normalizeContext({
      messages: [{ role: "user", content: "Hello", timestamp: 1 }],
    }),
    { onPayload },
  ).result();
  expect(onPayload).toHaveBeenCalledOnce();
  expect(upstream.requests).toHaveLength(1);
  expect(upstream.requests[0].body).toMatchObject({ max_tokens: 17 });
});
