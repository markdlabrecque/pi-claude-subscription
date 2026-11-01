import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// Mock cross-spawn with PassThrough streams so each test drives the callbacks
vi.mock("cross-spawn", () => ({
  default: vi.fn(() => {
    const proc = new EventEmitter();
    (proc as any).stdin = { write: vi.fn(), end: vi.fn() };
    (proc as any).stdout = new PassThrough();
    (proc as any).stderr = new EventEmitter();
    (proc as any).killed = false;
    (proc as any).exitCode = null;
    (proc as any).signalCode = null;
    (proc as any).kill = vi.fn(() => {
      (proc as any).killed = true;
    });
    return proc;
  }),
}));

// A relay whose start the test controls
const { relay, relayStart } = vi.hoisted(() => {
  const relay = {
    url: "http://127.0.0.1:1",
    upstreamCount: 0,
    rejectedCount: 0,
    failure: undefined as { status: number } | undefined,
    stop: vi.fn(async () => {}),
  };
  return { relay, relayStart: { impl: undefined as any } };
});
vi.mock("../src/relay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/relay")>()),
  startRelay: vi.fn(() => (relayStart.impl ? relayStart.impl() : relay)),
}));

const { MockAssistantMessageEventStream } = vi.hoisted(() => {
  const MockAssistantMessageEventStream: any = vi.fn(function (this: any) {
    const events: any[] = [];
    this.push = vi.fn((event: any) => events.push(event));
    this.end = vi.fn();
    this._events = events;
  });
  return { MockAssistantMessageEventStream };
});

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
  return {
    createAssistantMessageEventStream: () =>
      new MockAssistantMessageEventStream(),
    calculateCost: vi.fn(),
    getCurrentSystemPrompt: actual.getCurrentSystemPrompt,
    normalizeContext: actual.normalizeContext,
  };
});

import spawn from "cross-spawn";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamViaCli } from "../src/provider";
import { startRelay } from "../src/relay";
import { writeMcpConfig } from "../src/mcp-config";
import { SESSION_MODE_ENV } from "../src/session-mode";

const model = {
  id: "claude-sonnet-4-5-20250929",
  provider: "anthropic",
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
} as any;

const realTmpdir = process.env.TMPDIR;
let tmpSandbox: string;
beforeAll(() => {
  tmpSandbox = mkdtempSync(join(tmpdir(), "cancellation-test-"));
  process.env.TMPDIR = tmpSandbox;
});
afterAll(() => {
  if (realTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = realTmpdir;
  rmSync(tmpSandbox, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  relay.failure = undefined;
  relay.upstreamCount = 0;
  relayStart.impl = undefined;
});
afterEach(() => {
  vi.useRealTimers();
});

const userContext = { messages: [{ role: "user", content: "Hello" }] };

const ev = (event: any) =>
  JSON.stringify({ type: "stream_event", event }) + "\n";
const startLines = ev({
  type: "message_start",
  message: { usage: { input_tokens: 7, output_tokens: 0 } },
});
const textStart = ev({
  type: "content_block_start",
  index: 0,
  content_block: { type: "text", text: "" },
});
const textDelta = (text: string) =>
  ev({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  });
const resultLine =
  JSON.stringify({ type: "result", subtype: "success", is_error: false }) +
  "\n";

function lastStream(): any {
  const instances = MockAssistantMessageEventStream.mock.instances;
  return instances[instances.length - 1];
}

/** Start a request and wait for the CLI to be spawned. */
async function startStreaming(options: any = {}) {
  streamViaCli(model, userContext, options);
  await vi.advanceTimersByTimeAsync(0);
  return (spawn as any).mock.results[0].value;
}

function terminals(stream: any): any[] {
  return stream._events.filter(
    (e: any) => e.type === "done" || e.type === "error",
  );
}

/** The single terminal event, asserted to be a typed cancellation. */
function oneAborted(stream: any): any {
  const terminal = terminals(stream);
  expect(terminal).toHaveLength(1);
  expect(terminal[0].type).toBe("error");
  expect(terminal[0].reason).toBe("aborted");
  expect(stream.end).toHaveBeenCalledTimes(1);
  const message = terminal[0].error;
  expect(message.role).toBe("assistant");
  expect(Array.isArray(message.content)).toBe(true);
  expect(message.stopReason).toBe("aborted");
  expect(message.errorMessage).toBeTruthy();
  return message;
}

/** Let the CLI's streams and process close in order, after the kill. */
async function closeProcess(
  proc: any,
  code: number | null,
  signal: string | null,
) {
  proc.stdout.end();
  proc.exitCode = code;
  proc.emit("close", code, signal);
  await vi.advanceTimersByTimeAsync(1000);
}

describe("streamViaCli cancellation", () => {
  it("reports an already-aborted signal as canceled without starting anything", async () => {
    const mcpConfigPath = writeMcpConfig([]);
    const controller = new AbortController();
    controller.abort();

    streamViaCli(model, userContext, {
      signal: controller.signal,
      mcpConfigPath,
    });
    await vi.advanceTimersByTimeAsync(100);

    const message = oneAborted(lastStream());
    expect(message.content).toEqual([]);
    expect(startRelay).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(mcpConfigPath)).toBe(false);
  });

  it("reports an abort during relay startup as canceled, never spawns, and stops the relay", async () => {
    let finishStart!: (r: typeof relay) => void;
    relayStart.impl = () =>
      new Promise((resolve) => {
        finishStart = resolve;
      });
    const controller = new AbortController();
    streamViaCli(model, userContext, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);

    controller.abort();
    finishStart(relay);
    await vi.advanceTimersByTimeAsync(100);

    oneAborted(lastStream());
    expect(spawn).not.toHaveBeenCalled();
    expect(relay.stop).toHaveBeenCalled();
  });

  it("keeps partial content and usage when aborted mid-stream, and later callbacks change nothing", async () => {
    const controller = new AbortController();
    const proc = await startStreaming({ signal: controller.signal });
    proc.stdout.write(startLines + textStart + textDelta("Partial"));
    await vi.advanceTimersByTimeAsync(10);

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");

    const stream = lastStream();
    const message = oneAborted(stream);
    expect(JSON.stringify(message.content)).toContain("Partial");
    expect(message.usage.input).toBe(7);
    const snapshot = JSON.stringify(message);

    // Buffered output, EOF and the kill's close arrive after settlement
    proc.stdout.write(textDelta(" more") + resultLine);
    await closeProcess(proc, null, "SIGKILL");

    expect(oneAborted(stream)).toBe(message);
    expect(JSON.stringify(message)).toBe(snapshot);
    expect(relay.stop).toHaveBeenCalled();
  });

  it("reports an abort before any content as canceled with empty content", async () => {
    const controller = new AbortController();
    const proc = await startStreaming({ signal: controller.signal });

    controller.abort();
    await closeProcess(proc, null, "SIGKILL");

    const message = oneAborted(lastStream());
    expect(message.content).toEqual([]);
  });

  it("does not let a result line that arrives after the abort turn it into success", async () => {
    const controller = new AbortController();
    const proc = await startStreaming({ signal: controller.signal });
    proc.stdout.write(startLines + textStart + textDelta("Partial"));
    await vi.advanceTimersByTimeAsync(10);

    controller.abort();
    proc.stdout.write(resultLine);
    proc.stdout.end();
    await vi.advanceTimersByTimeAsync(100);

    const message = oneAborted(lastStream());
    expect(JSON.stringify(message.content)).toContain("Partial");
  });

  it("does not let EOF with a clean exit after the abort turn it into success", async () => {
    const controller = new AbortController();
    const proc = await startStreaming({ signal: controller.signal });
    proc.stdout.write(startLines + textStart + textDelta("Partial"));
    await vi.advanceTimersByTimeAsync(10);

    controller.abort();
    await closeProcess(proc, 0, null);

    oneAborted(lastStream());
  });

  it("leaves an already successful request alone when aborted afterwards", async () => {
    const controller = new AbortController();
    const proc = await startStreaming({ signal: controller.signal });
    proc.stdout.write(
      startLines +
        textStart +
        textDelta("Done text") +
        ev({ type: "content_block_stop", index: 0 }) +
        ev({ type: "message_delta", delta: { stop_reason: "end_turn" } }) +
        ev({ type: "message_stop" }) +
        resultLine,
    );
    await vi.advanceTimersByTimeAsync(100);
    const stream = lastStream();
    const before = terminals(stream);
    expect(before).toHaveLength(1);
    expect(before[0].type).toBe("done");
    const snapshot = JSON.stringify(before[0].message);

    controller.abort();
    await closeProcess(proc, null, "SIGKILL");

    const after = terminals(stream);
    expect(after).toHaveLength(1);
    expect(after[0].type).toBe("done");
    expect(JSON.stringify(after[0].message)).toBe(snapshot);
    expect(stream.end).toHaveBeenCalledTimes(1);
  });

  it("keeps request and inactivity timeouts as failures, not cancellations", async () => {
    const proc = await startStreaming();
    proc.stdout.write(startLines + textStart + textDelta("Partial"));
    await vi.advanceTimersByTimeAsync(10);

    await vi.advanceTimersByTimeAsync(181_000);

    const stream = lastStream();
    const terminal = terminals(stream);
    expect(terminal).toHaveLength(1);
    expect(terminal[0].reason).toBe("error");
    expect(terminal[0].error.stopReason).toBe("error");
    expect(terminal[0].error.errorMessage).toContain("timed out");
    expect(JSON.stringify(terminal[0].error.content)).toContain("Partial");
  });

  it("reports a late nonzero close after stdout EOF as an error that keeps partial content", async () => {
    const proc = await startStreaming();
    proc.stdout.write(startLines + textStart + textDelta("Partial"));
    await vi.advanceTimersByTimeAsync(10);

    proc.stdout.end();
    await vi.advanceTimersByTimeAsync(50);
    proc.stderr.emit("data", Buffer.from("boom"));
    proc.exitCode = 3;
    proc.emit("close", 3, null);
    await vi.advanceTimersByTimeAsync(100);

    const stream = lastStream();
    const terminal = terminals(stream);
    expect(terminal).toHaveLength(1);
    expect(terminal[0].type).toBe("error");
    expect(terminal[0].reason).toBe("error");
    expect(terminal[0].error.errorMessage).toContain("boom");
    expect(JSON.stringify(terminal[0].error.content)).toContain("Partial");
    expect(terminal[0].error.usage.input).toBe(7);
  });

  it("does not mutate a failed result with output that was buffered behind the failure", async () => {
    const proc = await startStreaming();
    proc.stdout.write(startLines + textStart + textDelta("Partial"));
    await vi.advanceTimersByTimeAsync(10);

    proc.emit("error", new Error("spawn failed"));
    const stream = lastStream();
    const terminal = terminals(stream);
    expect(terminal).toHaveLength(1);
    expect(terminal[0].reason).toBe("error");
    const snapshot = JSON.stringify(terminal[0].error);

    proc.stdout.write(
      textDelta(" late") +
        ev({
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 99 },
        }) +
        resultLine,
    );
    await closeProcess(proc, 0, null);

    expect(terminals(stream)).toHaveLength(1);
    expect(JSON.stringify(terminals(stream)[0].error)).toBe(snapshot);
  });

  it("does not start a replay attempt for a lost resumed session once canceled", async () => {
    const controller = new AbortController();
    streamViaCli(
      model,
      {
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: [{ type: "text", text: "Hi" }] },
          { role: "user", content: "Again" },
        ],
      },
      {
        signal: controller.signal,
        sessionId: "session-1",
        env: { [SESSION_MODE_ENV]: "resume" },
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    const proc = (spawn as any).mock.results[0].value;
    // Reconfirm this was a resume attempt, the only one that may fall back
    expect((spawn as any).mock.calls[0][1]).toContain("--resume");

    controller.abort();
    proc.stderr.emit(
      "data",
      Buffer.from("No conversation found with session ID: session-1"),
    );
    await closeProcess(proc, 1, null);

    oneAborted(lastStream());
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
