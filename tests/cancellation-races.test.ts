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

const { relay } = vi.hoisted(() => ({
  relay: {
    url: "http://127.0.0.1:1",
    upstreamCount: 0,
    rejectedCount: 0,
    failure: undefined as { status: number } | undefined,
    stop: vi.fn(async () => {}),
  },
}));
vi.mock("../src/relay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/relay")>()),
  startRelay: vi.fn(() => relay),
}));

// A setup step after spawn that the test can make throw
const { setupFailure } = vi.hoisted(() => ({
  setupFailure: { error: undefined as Error | undefined },
}));
vi.mock("../src/process-manager", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/process-manager")>();
  return {
    ...actual,
    writeUserMessage: vi.fn(
      (...args: Parameters<typeof actual.writeUserMessage>) => {
        if (setupFailure.error) throw setupFailure.error;
        actual.writeUserMessage(...args);
      },
    ),
  };
});

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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamViaCli } from "../src/provider";
import { REQUEST_TIMEOUT_ENV } from "../src/process-manager";

const model = {
  id: "claude-sonnet-4-5-20250929",
  provider: "anthropic",
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
} as any;

const realTmpdir = process.env.TMPDIR;
let tmpSandbox: string;
beforeAll(() => {
  tmpSandbox = mkdtempSync(join(tmpdir(), "cancellation-races-test-"));
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
  setupFailure.error = undefined;
});
afterEach(() => {
  vi.useRealTimers();
});

const userContext = { messages: [{ role: "user", content: "Hello" }] };

const ev = (event: any) =>
  JSON.stringify({ type: "stream_event", event }) + "\n";
const partialLines =
  ev({
    type: "message_start",
    message: { usage: { input_tokens: 7, output_tokens: 0 } },
  }) +
  ev({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  }) +
  ev({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Partial" },
  });

function lastStream(): any {
  const instances = MockAssistantMessageEventStream.mock.instances;
  return instances[instances.length - 1];
}

/** Start a request, wait for the CLI to be spawned and stream partial text. */
async function startWithPartial(options: any = {}) {
  streamViaCli(model, userContext, options);
  await vi.advanceTimersByTimeAsync(0);
  const proc = (spawn as any).mock.results[0].value;
  proc.stdout.write(partialLines);
  await vi.advanceTimersByTimeAsync(10);
  return proc;
}

/** The single terminal event, with `stream.end` called once. */
function oneTerminal(stream: any): any {
  const terminal = stream._events.filter(
    (e: any) => e.type === "done" || e.type === "error",
  );
  expect(terminal).toHaveLength(1);
  expect(stream.end).toHaveBeenCalledTimes(1);
  return terminal[0];
}

function expectAborted(terminal: any) {
  expect(terminal.type).toBe("error");
  expect(terminal.reason).toBe("aborted");
  expect(terminal.error.stopReason).toBe("aborted");
  expect(terminal.error.errorMessage).toBeTruthy();
  expect(JSON.stringify(terminal.error.content)).toContain("Partial");
  expect(terminal.error.usage.input).toBe(7);
}

function expectTimedOut(terminal: any, text: string) {
  expect(terminal.type).toBe("error");
  expect(terminal.reason).toBe("error");
  expect(terminal.error.stopReason).toBe("error");
  expect(terminal.error.errorMessage).toContain(text);
  expect(JSON.stringify(terminal.error.content)).toContain("Partial");
}

async function closeKilled(proc: any) {
  proc.stdout.end();
  proc.signalCode = "SIGKILL";
  proc.emit("close", null, "SIGKILL");
  await vi.advanceTimersByTimeAsync(1000);
}

describe("streamViaCli cancellation races", () => {
  it("keeps the cancellation when the process then reports an error", async () => {
    const controller = new AbortController();
    const proc = await startWithPartial({ signal: controller.signal });

    controller.abort();
    const stream = lastStream();
    const terminal = oneTerminal(stream);
    expectAborted(terminal);
    const snapshot = JSON.stringify(terminal);

    proc.emit("error", new Error("EPIPE"));
    await closeKilled(proc);

    expect(oneTerminal(stream)).toBe(terminal);
    expect(JSON.stringify(terminal)).toBe(snapshot);
  });

  it("keeps the cancellation when the inactivity and request timeouts would have fired", async () => {
    const controller = new AbortController();
    await startWithPartial({ signal: controller.signal });

    controller.abort();
    const stream = lastStream();
    const terminal = oneTerminal(stream);
    expectAborted(terminal);
    const snapshot = JSON.stringify(terminal);

    // Past the 180s inactivity and the default 600s request timeouts
    await vi.advanceTimersByTimeAsync(601_000);

    expect(oneTerminal(stream)).toBe(terminal);
    expect(JSON.stringify(terminal)).toBe(snapshot);
  });

  it("keeps an inactivity timeout failure when Pi cancels afterwards", async () => {
    const controller = new AbortController();
    const proc = await startWithPartial({ signal: controller.signal });

    await vi.advanceTimersByTimeAsync(181_000);
    const stream = lastStream();
    const terminal = oneTerminal(stream);
    expectTimedOut(terminal, "no output for 180 seconds");
    const snapshot = JSON.stringify(terminal);

    controller.abort();
    await closeKilled(proc);

    expect(oneTerminal(stream)).toBe(terminal);
    expect(JSON.stringify(terminal)).toBe(snapshot);
  });

  it("keeps a request timeout failure when Pi cancels afterwards", async () => {
    const controller = new AbortController();
    const proc = await startWithPartial({
      signal: controller.signal,
      env: { [REQUEST_TIMEOUT_ENV]: "5000" },
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    const stream = lastStream();
    const terminal = oneTerminal(stream);
    expectTimedOut(terminal, "timed out after 5 seconds");
    const snapshot = JSON.stringify(terminal);

    controller.abort();
    await closeKilled(proc);

    expect(oneTerminal(stream)).toBe(terminal);
    expect(JSON.stringify(terminal)).toBe(snapshot);
  });
});

describe("streamViaCli setup failure after spawn", () => {
  it("reports one error, kills the started CLI and stops the relay", async () => {
    setupFailure.error = new Error("stdin closed");

    streamViaCli(model, userContext);
    await vi.advanceTimersByTimeAsync(0);

    const terminal = oneTerminal(lastStream());
    expect(terminal.type).toBe("error");
    expect(terminal.reason).toBe("error");
    expect(terminal.error.stopReason).toBe("error");
    expect(terminal.error.errorMessage).toBe("stdin closed");
    const proc = (spawn as any).mock.results[0].value;
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    expect(relay.stop).toHaveBeenCalled();
  });
});
