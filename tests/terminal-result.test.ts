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

// Mock cross-spawn with PassThrough streams for readline compatibility
vi.mock("cross-spawn", () => ({
  default: vi.fn(() => {
    const proc = new EventEmitter();
    (proc as any).stdin = { write: vi.fn(), end: vi.fn() };
    (proc as any).stdout = new PassThrough();
    (proc as any).stderr = new EventEmitter();
    (proc as any).killed = false;
    (proc as any).exitCode = null;
    (proc as any).kill = vi.fn(() => {
      (proc as any).killed = true;
    });
    return proc;
  }),
}));

// A relay whose upstream failure each test sets; describeFailure stays real
const { relay } = vi.hoisted(() => ({
  relay: {
    url: "http://127.0.0.1:1",
    upstreamCount: 1,
    rejectedCount: 0,
    failure: undefined as { status: number } | undefined,
    stop: async () => {},
  },
}));
vi.mock("../src/relay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/relay")>()),
  startRelay: vi.fn(async () => relay),
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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamViaCli } from "../src/provider";

const model = {
  id: "claude-sonnet-4-5-20250929",
  provider: "anthropic",
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
} as any;

// The mocked process leaves spawnClaude's temp directories behind
const realTmpdir = process.env.TMPDIR;
let tmpSandbox: string;
beforeAll(() => {
  tmpSandbox = mkdtempSync(join(tmpdir(), "terminal-result-test-"));
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
});
afterEach(() => {
  vi.useRealTimers();
});

/** The single terminal event, asserted to be a typed error. */
function oneTypedError(stream: any): any {
  const terminal = stream._events.filter(
    (e: any) => e.type === "done" || e.type === "error",
  );
  expect(terminal).toHaveLength(1);
  expect(terminal[0].type).toBe("error");
  expect(terminal[0].reason).toBe("error");
  expect(stream.end).toHaveBeenCalledTimes(1);
  const message = terminal[0].error;
  expect(message.role).toBe("assistant");
  expect(Array.isArray(message.content)).toBe(true);
  expect(message.stopReason).toBe("error");
  expect(message.errorMessage).toBeTruthy();
  return message;
}

describe("streamViaCli terminal results", () => {
  it("reports a known upstream failure after partial content", async () => {
    streamViaCli(model, { messages: [{ role: "user", content: "Hello" }] });
    await vi.advanceTimersByTimeAsync(0);
    const proc = (spawn as any).mock.results[0].value;

    for (const line of [
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { usage: { input_tokens: 7, output_tokens: 0 } },
        },
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Partial" },
        },
      },
    ]) {
      proc.stdout.write(JSON.stringify(line) + "\n");
    }
    await vi.advanceTimersByTimeAsync(10);

    // Upstream overloaded mid-turn; the CLI then exits cleanly without a result
    relay.failure = { status: 529 };
    proc.exitCode = 0;
    proc.emit("close", 0, null);
    proc.stdout.end();
    await vi.advanceTimersByTimeAsync(100);

    const stream = MockAssistantMessageEventStream.mock.instances[0];
    const message = oneTypedError(stream);
    expect(message.errorMessage).toBe("Claude API returned 529 (overloaded).");
    expect(JSON.stringify(message.content)).toContain("Partial");
    expect(message.usage.input).toBe(7);
  });

  it("returns a valid assistant message when setup throws before the bridge exists", async () => {
    const context = {
      messages: [{ role: "user", content: "Hello" }],
      get tools(): { name: string }[] {
        throw new Error("tools exploded");
      },
    };

    streamViaCli(model, context);
    await vi.advanceTimersByTimeAsync(100);

    expect(spawn).not.toHaveBeenCalled();
    const stream = MockAssistantMessageEventStream.mock.instances[0];
    const message = oneTypedError(stream);
    expect(message.errorMessage).toContain("tools exploded");
    expect(message.content).toEqual([]);
    expect(message.model).toBe(model.id);
    expect(message.usage).toMatchObject({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { total: 0 },
    });
  });
});
