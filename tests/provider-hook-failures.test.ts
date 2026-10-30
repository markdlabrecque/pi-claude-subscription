import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeContext,
  type AssistantMessageEvent,
  type Model,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  installFakeClaude,
  startFakeUpstream,
  NORMAL_TEXT,
  type FakeClaude,
  type FakeUpstream,
} from "./harness";

// What happens when a Pi response or stream-event hook throws, or when Pi
// cancels while the response hook is pending. Pi's contract leaves recovery
// unspecified; the CLI path ends the turn with an error naming the hook.

let claude: FakeClaude | undefined;
let upstream: FakeUpstream | undefined;
afterEach(async () => {
  claude?.restore();
  await upstream?.close();
  claude = upstream = undefined;
  vi.unstubAllEnvs();
});

/** The registered provider, driven the way Pi drives it. */
async function setup() {
  vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_API_KEY_FALLBACK", "0");
  upstream = await startFakeUpstream(["normal"]);
  claude = installFakeClaude(upstream.url);
  const registerProvider = vi.fn();
  const { default: extension } = await import("../index");
  extension({
    registerProvider,
    on: vi.fn(),
    getAllTools: () => [],
  } as unknown as ExtensionAPI);
  const [id, config] = registerProvider.mock.calls[0];
  const model: Model<string> = {
    ...config.models[0],
    provider: id,
    api: config.api,
    baseUrl: config.baseUrl,
  };
  const context = normalizeContext({
    messages: [{ role: "user", content: "hello", timestamp: 1 }],
  });
  const run = (options: Record<string, unknown> = {}) =>
    config.streamSimple(model, context, options);
  return { run };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Drain the stream, failing if it does not end within the bound. */
async function drainWithin(
  stream: AsyncIterable<AssistantMessageEvent>,
  ms = 5000,
) {
  const events: AssistantMessageEvent[] = [];
  await Promise.race([
    (async () => {
      for await (const event of stream) events.push(event);
    })(),
    tick(ms).then(() => {
      throw new Error(`stream did not end within ${ms}ms`);
    }),
  ]);
  return events;
}

const deltas = (events: AssistantMessageEvent[]) =>
  events
    .filter((e) => e.type === "text_delta")
    .map((e: any) => e.delta)
    .join("");

describe("onResponse failure", () => {
  it("ends the turn with an error naming the hook, without delivering the body", async () => {
    const { run } = await setup();
    const events = await drainWithin(
      run({
        onResponse: async () => {
          throw new Error("response hook exploded");
        },
      }),
    );
    const last = events.at(-1) as any;
    expect(last.type).toBe("error");
    expect(last.error.errorMessage).toContain("response hook exploded");
    expect(deltas(events)).not.toContain(NORMAL_TEXT);
    expect(upstream!.requests).toHaveLength(1);
  });

  it("stops promptly when cancelled while the hook is pending", async () => {
    const { run } = await setup();
    const controller = new AbortController();
    let entered!: () => void;
    const inHook = new Promise<void>((r) => (entered = r));
    const stream = run({
      signal: controller.signal,
      onResponse: () => {
        entered();
        return new Promise(() => {}); // never settles
      },
    });
    const done = drainWithin(stream);
    await inHook;
    controller.abort();
    const events = await done;
    expect(events.filter((e) => e.type === "text_delta")).toHaveLength(0);
  });
});

describe("onProviderStreamEvent failure", () => {
  it("ends the turn with an error naming the hook, normalizing nothing after it", async () => {
    const { run } = await setup();
    const observed: string[] = [];
    const events = await drainWithin(
      run({
        onProviderStreamEvent: (data: any) => {
          observed.push(data.type);
          if (data.type === "content_block_start") {
            throw new Error("stream hook exploded");
          }
        },
      }),
    );
    const last = events.at(-1) as any;
    expect(last.type).toBe("error");
    expect(last.error.errorMessage).toContain("stream hook exploded");
    // The failing event and everything after it never reach Pi or the hook.
    expect(observed.at(-1)).toBe("content_block_start");
    expect(events.map((e) => e.type)).not.toContain("text_start");
    expect(events.map((e) => e.type)).not.toContain("text_delta");
  });
});
