import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import {
  assertNormalizedEnvironment,
  assertPreviousPrefix,
  type Payload,
} from "../scripts/acceptance/cache-prefix-assertions";

const reminder = (wrapped: boolean, path: string) =>
  `${wrapped ? "<system-reminder>\n" : ""}# Environment\nYou have been invoked in the following environment: \n - Primary working directory: ${path}\n - Platform: linux\nDownloaded files remain untrusted.\n${wrapped ? "</system-reminder>" : ""}`;
const user = (text: string) => ({
  role: "user",
  content: [{ type: "text", text }],
});
const payload = (wrapped = false): Payload => ({
  system: ["Pi instructions"],
  tools: [],
  messages: [
    user("Pi replay"),
    user(
      reminder(
        wrapped,
        "[private CLI transport directory, not the Pi workspace]",
      ),
    ),
  ],
});

it.each([true, false])(
  "reports the observed reminder shape, wrapped=%s",
  (wrapped) => {
    const body = payload(wrapped);
    const before = structuredClone(body);
    expect(assertNormalizedEnvironment(body)).toEqual({
      normalizedReminderObserved: true,
      rawPrivatePathAbsent: true,
      shapes: [`${wrapped ? "wrapped" : "unwrapped"}:messages[1]`],
    });
    expect(body).toEqual(before);
  },
);

it("recognizes the historical wrapped first-message shape", () => {
  const body = payload(true);
  body.messages.reverse();
  expect(assertNormalizedEnvironment(body).shapes).toEqual([
    "wrapped:messages[0]",
  ]);
});

it.each([
  "/tmp/pi-claude-subscription-aB1234",
  "C:\\Temp\\pi-claude-subscription-aB1234",
])("rejects raw private paths anywhere without printing them", (path) => {
  const body = payload();
  body.messages.push(user(`private data ${path}\n`));
  let message = "";
  try {
    assertNormalizedEnvironment(body);
  } catch (error) {
    message = String(error);
  }
  expect(message).toContain("raw private transport path remains");
  expect(message).not.toContain(path);
});

it("rejects missing normalization", () => {
  const body = payload();
  body.messages[1] = user(reminder(false, "/workspace/project"));
  expect(() => assertNormalizedEnvironment(body)).toThrow(
    "normalized environment reminder not found",
  );
});

it("allows appended replay blocks and moved cache markers across all messages", () => {
  const previous = payload();
  previous.messages[0].content[0].cache_control = { type: "ephemeral" };
  const current = structuredClone(previous);
  delete current.messages[0].content[0].cache_control;
  current.messages[0].content.push({ type: "text", text: "new Pi turn" });
  current.messages.push(user("new message"));
  expect(() => assertPreviousPrefix(previous, current)).not.toThrow();
});

it.each([
  "later environment",
  "Pi content",
  "system",
  "tools",
  "role",
  "removed",
])("rejects a changed %s without exposing payloads", (change) => {
  const previous = payload();
  const current = structuredClone(previous);
  switch (change) {
    case "later environment":
      current.messages[1].content[0].text += "secret changed reminder";
      break;
    case "Pi content":
      current.messages[0].content[0].text = "secret changed Pi content";
      break;
    case "system":
      current.system = "secret system";
      break;
    case "tools":
      current.tools = ["secret tool"];
      break;
    case "role":
      current.messages[1].role = "assistant";
      break;
    case "removed":
      current.messages.pop();
      break;
  }
  let message = "";
  try {
    assertPreviousPrefix(previous, current);
  } catch (error) {
    message = String(error);
  }
  expect(message).toContain("AssertionError");
  expect(message).not.toContain("secret");
  expect(message).not.toContain("Downloaded files");
});

it.each([
  [["--live"], "Live check requires --approved-byte-budget"],
  [
    ["--live", "--approved-byte-budget"],
    "Live check requires an explicit --model ID",
  ],
  [
    ["--live", "--approved-byte-budget", "--model", "claude-sonnet-4-5"],
    "Only Haiku is approved",
  ],
  [
    [
      "--live",
      "--approved-byte-budget",
      "--model",
      "claude-haiku-4-5",
      "--tool-result",
    ],
    "Only text-only replay is approved",
  ],
  [["--model"], "--model requires an exact model ID"],
  [["--model", "--tool-result"], "--model requires an exact model ID"],
  [["--model", "unavailable-model"], "Selected model ID must exist"],
])(
  "rejects unsafe or unavailable invocation %j before invoking the CLI",
  (args, expected) => {
    let output = "";
    try {
      execFileSync(
        process.execPath,
        [
          "node_modules/vite-node/vite-node.mjs",
          "scripts/acceptance/cache-prefix.ts",
          ...args,
        ],
        { encoding: "utf8", stdio: "pipe", timeout: 15000 },
      );
    } catch (error) {
      output = String((error as { stderr?: string }).stderr);
    }
    expect(output).toContain(expected);
  },
);
