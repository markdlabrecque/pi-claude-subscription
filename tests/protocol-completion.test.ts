import { describe, it, expect, afterEach } from "vitest";
import { streamViaCli } from "../src/provider";
import {
  startFakeUpstream,
  installFakeClaude,
  type FakeUpstream,
  type FakeClaude,
  model,
} from "./harness";

// Provider entry point, real Pi SDK, fake CLI replaying a scripted stdout.

const ENV_KEYS = ["FAKE_CLAUDE_STREAM_SCRIPT", "FAKE_CLAUDE_EXIT_CODE"];

let upstream: FakeUpstream | undefined;
let claude: FakeClaude | undefined;

afterEach(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  claude?.restore();
  await upstream?.close();
  claude = upstream = undefined;
});

const se = (event: any, extra: object = {}) => ({
  type: "stream_event",
  event,
  ...extra,
});
const start = (extra: object = {}) =>
  se(
    {
      type: "message_start",
      message: { usage: { input_tokens: 7, output_tokens: 1 } },
    },
    extra,
  );
const textStart = (index = 0, extra: object = {}) =>
  se(
    {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    },
    extra,
  );
const textDelta = (text: string, index = 0, extra: object = {}) =>
  se(
    { type: "content_block_delta", index, delta: { type: "text_delta", text } },
    extra,
  );
const blockStop = (index = 0, extra: object = {}) =>
  se({ type: "content_block_stop", index }, extra);
const stopReason = (reason: string, extra: object = {}) =>
  se(
    {
      type: "message_delta",
      delta: { stop_reason: reason },
      usage: { output_tokens: 5 },
    },
    extra,
  );
const messageStop = (extra: object = {}) => se({ type: "message_stop" }, extra);
const toolStart = (name: string, index = 0) =>
  se({
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", id: "toolu_1", name },
  });
const toolJson = (partial_json: string, index = 0) =>
  se({
    type: "content_block_delta",
    index,
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

async function run(script: unknown[], exitCode = 0) {
  upstream = await startFakeUpstream(["normal"]);
  claude = installFakeClaude(upstream.url);
  process.env.FAKE_CLAUDE_STREAM_SCRIPT = JSON.stringify(script);
  process.env.FAKE_CLAUDE_EXIT_CODE = String(exitCode);

  const stream = streamViaCli(model, {
    messages: [{ role: "user", content: "Hello", timestamp: 1 }],
  });
  const events: any[] = [];
  for await (const e of stream) events.push(e);
  const result = (await stream.result()) as any;
  // Let any late (post-terminal) work run before asserting nothing followed.
  await new Promise((r) => setTimeout(r, 50));
  const terminal = events.filter(
    (e) => e.type === "done" || e.type === "error",
  );
  expect(terminal).toHaveLength(1);
  expect(events[events.length - 1]).toBe(terminal[0]);
  expect(upstream.requests).toHaveLength(1);
  return { events, result, terminal: terminal[0] };
}

function expectProtocolError(r: Awaited<ReturnType<typeof run>>) {
  expect(r.terminal.type).toBe("error");
  expect(r.terminal.reason).toBe("error");
  expect(r.terminal.error).toBe(r.result);
  expect(r.result.stopReason).toBe("error");
  expect(typeof r.result.errorMessage).toBe("string");
  expect(r.result.errorMessage.length).toBeGreaterThan(0);
  // No successful completion event of any kind
  expect(r.events.some((e) => e.type === "done")).toBe(false);
}

describe("incomplete CLI protocol completions fail explicitly", () => {
  it("empty clean exit", async () => {
    expectProtocolError(await run([]));
  });

  it("malformed-only output", async () => {
    expectProtocolError(await run(["{not json", "[debug] noise", '{"x":']));
  });

  it("zero blocks with nominal success", async () => {
    const r = await run([
      start(),
      stopReason("end_turn"),
      messageStop(),
      resultOk(),
    ]);
    expectProtocolError(r);
    expect(r.result.content).toEqual([]);
    expect(r.result.usage.input).toBe(7);
  });

  it("completed empty text", async () => {
    const r = await run([
      start(),
      textStart(),
      textDelta(""),
      blockStop(),
      stopReason("end_turn"),
      messageStop(),
      resultOk(),
    ]);
    expectProtocolError(r);
    expect(r.result.usage.input).toBe(7);
  });

  it("EOF before top-level message completion", async () => {
    const r = await run([
      start(),
      textStart(),
      textDelta("Whole block"),
      blockStop(),
    ]);
    expectProtocolError(r);
    expect(JSON.stringify(r.result.content)).toContain("Whole block");
    expect(r.result.usage.input).toBe(7);
  });

  it("partial text then EOF", async () => {
    const r = await run([start(), textStart(), textDelta("Partial")]);
    expectProtocolError(r);
    expect(JSON.stringify(r.result.content)).toContain("Partial");
    expect(r.result.usage.input).toBe(7);
  });

  it("partial text then nominal success without completion", async () => {
    const r = await run([
      start(),
      textStart(),
      textDelta("Partial"),
      resultOk(),
    ]);
    expectProtocolError(r);
    expect(JSON.stringify(r.result.content)).toContain("Partial");
  });

  it("missing stop reason is not a successful stop", async () => {
    expectProtocolError(
      await run([
        start(),
        textStart(),
        textDelta("Hi"),
        blockStop(),
        messageStop(),
        resultOk(),
      ]),
    );
  });

  it("unknown stop reason is not a successful stop", async () => {
    const r = await run([...completeText("Hi", "bogus_reason"), resultOk()]);
    expectProtocolError(r);
    expect(JSON.stringify(r.result.content)).toContain("Hi");
  });

  it("result-only success never manufactures text or usage from the summary", async () => {
    const r = await run([
      resultOk({
        result: "Synthetic summary text",
        usage: { input_tokens: 99, output_tokens: 99 },
      }),
    ]);
    expectProtocolError(r);
    expect(JSON.stringify(r.result.content)).not.toContain("Synthetic summary");
    expect(r.result.usage.input).toBe(0);
    expect(r.result.usage.output).toBe(0);
  });

  it("sub-agent-only events do not prove a successful reply", async () => {
    const sub = { parent_tool_use_id: "toolu_parent" };
    const r = await run([
      ...completeText("Internal", "end_turn").map((l) => ({ ...l, ...sub })),
      resultOk(),
    ]);
    expectProtocolError(r);
    expect(JSON.stringify(r.result.content)).not.toContain("Internal");
  });

  it("a sub-agent message_stop does not complete a partial top-level reply", async () => {
    const r = await run([
      start(),
      textStart(),
      textDelta("Top"),
      messageStop({ parent_tool_use_id: "toolu_parent" }),
      resultOk(),
    ]);
    expectProtocolError(r);
    expect(JSON.stringify(r.result.content)).toContain("Top");
  });

  it("a truncated tool block is not a completed toolUse", async () => {
    const r = await run([
      start(),
      toolStart("Read"),
      toolJson('{"file_path":"a.t'),
      stopReason("tool_use"),
      messageStop(),
    ]);
    expectProtocolError(r);
    expect(r.result.stopReason).not.toBe("toolUse");
    for (const block of r.result.content) {
      if (block.type === "toolCall")
        expect(typeof block.arguments).not.toBe("string");
    }
    expect(r.events.some((e) => e.type === "toolcall_end")).toBe(false);
    expect(r.result.usage.input).toBe(7);
  });

  it("unparseable tool JSON is not a raw-string toolcall_end", async () => {
    const r = await run([
      start(),
      toolStart("Read"),
      toolJson("{not json"),
      blockStop(),
      stopReason("tool_use"),
      messageStop(),
    ]);
    expectProtocolError(r);
    for (const e of r.events) {
      if (e.type === "toolcall_end")
        expect(typeof e.toolCall.arguments).not.toBe("string");
    }
    for (const block of r.result.content) {
      if (block.type === "toolCall")
        expect(typeof block.arguments).not.toBe("string");
    }
  });
});

describe("fatal CLI results win over nominal completion", () => {
  it("after complete streamed text", async () => {
    const r = await run(
      [...completeText("Whole answer"), resultError("upstream exploded")],
      1,
    );
    expectProtocolError(r);
    expect(r.result.errorMessage).toContain("upstream exploded");
    expect(JSON.stringify(r.result.content)).toContain("Whole answer");
    expect(r.result.usage.input).toBe(7);
    expect(r.result.usage.output).toBe(5);
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
    expectProtocolError(r);
    expect(r.result.errorMessage).toContain("upstream exploded");
    expect(JSON.stringify(r.result.content)).toContain("Half");
  });
});

describe("valid completions end once with the right reason", () => {
  it("end_turn text → done/stop", async () => {
    const r = await run([...completeText("All good"), resultOk()]);
    expect(r.terminal.type).toBe("done");
    expect(r.terminal.reason).toBe("stop");
    expect(r.terminal.message).toBe(r.result);
    expect(r.result.stopReason).toBe("stop");
    expect(r.result.content).toEqual([{ type: "text", text: "All good" }]);
    expect(r.result.errorMessage).toBeUndefined();
    expect(r.result.usage.input).toBe(7);
    expect(r.result.usage.output).toBe(5);
  });

  it("completed max_tokens text → done/length", async () => {
    const r = await run([...completeText("Cut off", "max_tokens"), resultOk()]);
    expect(r.terminal.type).toBe("done");
    expect(r.terminal.reason).toBe("length");
    expect(r.result.stopReason).toBe("length");
    expect(r.result.content).toEqual([{ type: "text", text: "Cut off" }]);
  });

  it.each([
    ["built-in", "Read", "read"],
    ["MCP", "mcp__srv__deploy", "deploy"],
    ["unknown but well-formed", "totally_made_up_tool", "totally_made_up_tool"],
  ])(
    "completed %s tool call breaks early → done/toolUse without a result or clean exit",
    async (_label, claudeName, piName) => {
      const r = await run(
        [
          start(),
          toolStart(claudeName),
          toolJson('{"path":"a.txt"}'),
          blockStop(),
          stopReason("tool_use"),
          messageStop(),
        ],
        1,
      );
      expect(r.terminal.type).toBe("done");
      expect(r.terminal.reason).toBe("toolUse");
      expect(r.result.stopReason).toBe("toolUse");
      expect(r.result.content).toHaveLength(1);
      expect(r.result.content[0]).toMatchObject({
        type: "toolCall",
        id: "toolu_1",
        name: piName,
      });
      expect(typeof r.result.content[0].arguments).toBe("object");
    },
  );
});
