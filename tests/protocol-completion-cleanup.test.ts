import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every push the provider makes, recorded on the real SDK stream, so the
// SDK's suppression of pushes after a terminal event can't hide a second
// terminal event or a later change to the terminal message.
const { pushes } = vi.hoisted(() => ({ pushes: [] as any[] }));

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
  return {
    ...actual,
    createAssistantMessageEventStream: () => {
      const stream = actual.createAssistantMessageEventStream();
      const push = stream.push.bind(stream);
      stream.push = (event: any) => {
        pushes.push(event);
        push(event);
      };
      return stream;
    },
  };
});

import { streamViaCli } from "../src/provider";
import { writeMcpConfig } from "../src/mcp-config";
import {
  startFakeUpstream,
  installFakeClaude,
  type FakeUpstream,
  type FakeClaude,
  model,
} from "./harness";

// Provider entry point, real Pi SDK, fake CLI replaying a scripted stdout:
// the specific diagnostic, one terminal push, and nothing left behind.

const ENV_KEYS = [
  "TMPDIR",
  "FAKE_CLAUDE_RECORD_FILE",
  "FAKE_CLAUDE_STREAM_SCRIPT",
  "FAKE_CLAUDE_EXIT_CODE",
];

let upstream: FakeUpstream | undefined;
let claude: FakeClaude | undefined;
let sandbox: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  pushes.length = 0;
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  // A private TMPDIR, so only this test's temp directories are counted
  sandbox = mkdtempSync(join(tmpdir(), "protocol-cleanup-test-"));
  process.env.TMPDIR = sandbox;
  process.env.FAKE_CLAUDE_RECORD_FILE = join(sandbox, "record.json");
});

afterEach(async () => {
  claude?.restore();
  await upstream?.close();
  claude = upstream = undefined;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

const se = (event: any, extra: object = {}) => ({
  type: "stream_event",
  event,
  ...extra,
});
const start = () =>
  se({
    type: "message_start",
    message: { usage: { input_tokens: 7, output_tokens: 1 } },
  });
const textStart = (index = 0) =>
  se({
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "" },
  });
const textDelta = (text: string, index = 0) =>
  se({
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  });
const blockStop = (index = 0) => se({ type: "content_block_stop", index });
const stopReason = (reason: string) =>
  se({
    type: "message_delta",
    delta: { stop_reason: reason },
    usage: { output_tokens: 5 },
  });
const messageStop = (extra: object = {}) => se({ type: "message_stop" }, extra);
const toolStart = (name: string) =>
  se({
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "toolu_1", name },
  });
const toolJson = (partial_json: string) =>
  se({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json },
  });
const resultOk = (extra: object = {}) => ({
  type: "result",
  subtype: "success",
  session_id: "s",
  ...extra,
});
const resultError = (message: string) => ({
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  errors: [message],
});
const completeText = (text: string, reason = "end_turn") => [
  start(),
  textStart(),
  textDelta(text),
  blockStop(),
  stopReason(reason),
  messageStop(),
];
const toolCall = (name: string, json = '{"path":"a.txt"}') => [
  start(),
  toolStart(name),
  toolJson(json),
  blockStop(),
  stopReason("tool_use"),
  messageStop(),
];
const sub = { parent_tool_use_id: "toolu_parent" };

const PROTOCOL = "Claude CLI protocol error";
const ENDED_EARLY = `${PROTOCOL}: the response ended before the message completed.`;
const EMPTY = "Claude returned an empty reply";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function run(script: unknown[], exitCode = 0) {
  upstream = await startFakeUpstream(["normal"]);
  claude = installFakeClaude(upstream.url);
  process.env.FAKE_CLAUDE_STREAM_SCRIPT = JSON.stringify(script);
  process.env.FAKE_CLAUDE_EXIT_CODE = String(exitCode);

  const stream = streamViaCli(
    model,
    { messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
    { mcpConfigPath: writeMcpConfig([]) },
  );
  for await (const _event of stream) {
    // Drain; the assertions use the recorded pushes
  }
  const result = (await stream.result()) as any;

  const terminalAt = pushes.findIndex(
    (e) => e.type === "done" || e.type === "error",
  );
  expect(terminalAt).toBeGreaterThanOrEqual(0);
  const terminal = pushes[terminalAt];
  const message = terminal.type === "done" ? terminal.message : terminal.error;
  const snapshot = structuredClone(message);

  await expectNothingLeft();

  // Exactly one terminal push, the last push, and the message is unchanged
  expect(
    pushes.filter((e) => e.type === "done" || e.type === "error"),
  ).toHaveLength(1);
  expect(pushes.length - 1).toBe(terminalAt);
  expect(message).toEqual(snapshot);
  expect(result).toBe(message);
  expect(upstream.requests).toHaveLength(1);
  return { terminal, result };
}

/** The CLI process tree, relay, private directories and MCP config are gone. */
async function expectNothingLeft() {
  const record = JSON.parse(
    readFileSync(process.env.FAKE_CLAUDE_RECORD_FILE!, "utf-8"),
  );
  await vi.waitFor(() => {
    for (const pid of record.pids) expect(isAlive(pid)).toBe(false);
    expect(
      readdirSync(sandbox).filter((d) => d.startsWith("pi-claude-")),
    ).toEqual([]);
  });
  await expect(fetch(record.baseUrl)).rejects.toThrow();
}

function expectError(r: Awaited<ReturnType<typeof run>>, diagnostic: string) {
  expect(r.terminal.type).toBe("error");
  expect(r.terminal.reason).toBe("error");
  expect(r.result.role).toBe("assistant");
  expect(Array.isArray(r.result.content)).toBe(true);
  expect(r.result.stopReason).toBe("error");
  expect(r.result.errorMessage).toContain(diagnostic);
}

describe("incomplete completions: specific diagnostic and nothing left behind", () => {
  it.each([
    ["empty clean exit", [], ENDED_EARLY],
    [
      "malformed-only output",
      ["{not json", "[debug] noise", '{"x":'],
      ENDED_EARLY,
    ],
    [
      "zero blocks with nominal success",
      [start(), stopReason("end_turn"), messageStop(), resultOk()],
      EMPTY,
    ],
    ["completed empty text", [...completeText(""), resultOk()], EMPTY],
    [
      "EOF before top-level message completion",
      [start(), textStart(), textDelta("Whole block"), blockStop()],
      ENDED_EARLY,
    ],
    [
      "partial text then EOF",
      [start(), textStart(), textDelta("Partial")],
      ENDED_EARLY,
    ],
    [
      "partial text then nominal success",
      [start(), textStart(), textDelta("Partial"), resultOk()],
      ENDED_EARLY,
    ],
    [
      "missing stop reason",
      [
        start(),
        textStart(),
        textDelta("Hi"),
        blockStop(),
        messageStop(),
        resultOk(),
      ],
      `${PROTOCOL}: the message completed without a stop reason.`,
    ],
    [
      "unknown stop reason",
      [...completeText("Hi", "bogus_reason"), resultOk()],
      `${PROTOCOL}: unsupported stop reason "bogus_reason".`,
    ],
    [
      "result-only success",
      [resultOk({ result: "Synthetic summary text" })],
      ENDED_EARLY,
    ],
    [
      "sub-agent-only events",
      [...completeText("Internal").map((l) => ({ ...l, ...sub })), resultOk()],
      ENDED_EARLY,
    ],
    [
      "sub-agent message_stop after partial top-level text",
      [start(), textStart(), textDelta("Top"), messageStop(sub), resultOk()],
      ENDED_EARLY,
    ],
    [
      "truncated tool block",
      [
        start(),
        toolStart("Read"),
        toolJson('{"file_path":"a.t'),
        stopReason("tool_use"),
        messageStop(),
      ],
      `${PROTOCOL}: a content block did not complete.`,
    ],
    [
      "unparseable tool JSON",
      toolCall("Read", "{not json"),
      `${PROTOCOL}: the read tool call had unparseable arguments.`,
    ],
  ] as const)("%s", async (_label, script, diagnostic) => {
    expectError(await run([...script]), diagnostic);
  });

  it("keeps partial content and usage on a protocol error", async () => {
    const r = await run([start(), textStart(), textDelta("Partial")]);
    expectError(r, ENDED_EARLY);
    expect(r.result.content).toEqual([
      expect.objectContaining({ type: "text", text: "Partial" }),
    ]);
    expect(r.result.usage.input).toBe(7);
    expect(r.result.usage.cost.total).toBeGreaterThan(0);
  });
});

describe("a fatal CLI result wins: one error push, no later done", () => {
  it("after complete streamed text", async () => {
    const r = await run(
      [...completeText("Whole answer"), resultError("upstream exploded")],
      1,
    );
    expectError(r, "upstream exploded");
    expect(r.result.content).toEqual([
      expect.objectContaining({ type: "text", text: "Whole answer" }),
    ]);
    expect(r.result.usage.input).toBe(7);
    expect(r.result.usage.output).toBe(5);
    expect(pushes.some((e) => e.type === "done")).toBe(false);
  });

  it("after partial streamed text", async () => {
    const r = await run(
      [
        start(),
        textStart(),
        textDelta("Half"),
        resultError("upstream exploded"),
      ],
      1,
    );
    expectError(r, "upstream exploded");
    expect(r.result.content).toEqual([
      expect.objectContaining({ type: "text", text: "Half" }),
    ]);
    expect(pushes.some((e) => e.type === "done")).toBe(false);
  });
});

describe("valid completions end once and leave nothing behind", () => {
  it("end_turn text → done/stop", async () => {
    const r = await run([...completeText("All good"), resultOk()]);
    expect(r.terminal.type).toBe("done");
    expect(r.terminal.reason).toBe("stop");
    expect(r.result.stopReason).toBe("stop");
    expect(r.result.content).toEqual([{ type: "text", text: "All good" }]);
  });

  it("max_tokens text → done/length", async () => {
    const r = await run([...completeText("Cut off", "max_tokens"), resultOk()]);
    expect(r.terminal.type).toBe("done");
    expect(r.terminal.reason).toBe("length");
    expect(r.result.stopReason).toBe("length");
  });

  it.each([
    ["built-in", "Read", "read"],
    ["MCP", "mcp__srv__deploy", "deploy"],
    ["unknown but well-formed", "totally_made_up_tool", "totally_made_up_tool"],
  ])(
    "%s tool call breaks early → done/toolUse",
    async (_label, claudeName, piName) => {
      const r = await run(toolCall(claudeName), 1);
      expect(r.terminal.type).toBe("done");
      expect(r.terminal.reason).toBe("toolUse");
      expect(r.result.stopReason).toBe("toolUse");
      expect(r.result.content).toEqual([
        expect.objectContaining({
          type: "toolCall",
          id: "toolu_1",
          name: piName,
          arguments: { path: "a.txt" },
        }),
      ]);
    },
  );
});
