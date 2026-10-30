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
  type Scenario,
} from "./harness";

let claude: FakeClaude | undefined;
let upstream: FakeUpstream | undefined;
afterEach(async () => {
  claude?.restore();
  await upstream?.close();
  claude = upstream = undefined;
  delete process.env.FAKE_CLAUDE_NOT_LOGGED_IN;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const SECRET_PROMPT = "SECRET-PROMPT-TEXT";

/** The registered provider, driven the way Pi drives it. */
async function setup(scenarios: Scenario[] = ["normal"]) {
  vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_API_KEY_FALLBACK", "0");
  upstream = await startFakeUpstream(scenarios);
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
    messages: [{ role: "user", content: SECRET_PROMPT, timestamp: 1 }],
  });
  const run = (options: Record<string, unknown> = {}) =>
    config.streamSimple(model, context, options);
  return { model, run };
}

async function drain(stream: AsyncIterable<AssistantMessageEvent>) {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

describe("onPayload", () => {
  it("forwards an unchanged payload byte-for-byte equivalent, with the model, and no credentials", async () => {
    const { run, model } = await setup();
    const seen: unknown[] = [];
    const models: unknown[] = [];
    const events = await drain(
      run({
        onPayload: (payload: unknown, m: unknown) => {
          seen.push(structuredClone(payload));
          models.push(m);
        },
      }),
    );
    expect(events.at(-1)?.type).toBe("done");
    expect(seen).toHaveLength(1);
    expect(models[0]).toBe(model);
    expect(upstream!.requests).toHaveLength(1);
    expect(upstream!.requests[0].body).toEqual(seen[0]);
    expect(JSON.stringify(seen[0])).not.toContain("fake-oauth-token");
  });

  it("honors in-place edits and updates content-length", async () => {
    const { run } = await setup();
    await drain(
      run({
        onPayload: async (payload: any) => {
          await tick(10);
          payload.max_tokens = 77;
          payload.temperature = 0.25;
        },
      }),
    );
    const sent = upstream!.requests[0];
    expect(sent.body).toMatchObject({ max_tokens: 77, temperature: 0.25 });
    const length = Number(sent.headers["content-length"]);
    expect(length).toBe(Buffer.byteLength(JSON.stringify(sent.body)));
    expect(sent.headers.authorization).toBe("Bearer fake-oauth-token");
  });

  it("honors a returned replacement payload", async () => {
    const { run } = await setup();
    const replacement = {
      model: "claude-sonnet-4-5",
      max_tokens: 5,
      messages: [{ role: "user", content: "replaced" }],
    };
    const events = await drain(run({ onPayload: async () => replacement }));
    expect(upstream!.requests).toHaveLength(1);
    expect(upstream!.requests[0].body).toEqual(replacement);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("fails explicitly, without forwarding, when the hook rejects", async () => {
    const { run } = await setup();
    const events = await drain(
      run({
        onPayload: async () => {
          throw new Error("hook exploded");
        },
      }),
    );
    expect(upstream!.requests).toHaveLength(0);
    const text = JSON.stringify(events.at(-1));
    expect(text).not.toContain(NORMAL_TEXT);
    expect(text).toContain("hook exploded");
  });

  it("stops promptly when cancelled while the hook is pending, forwarding nothing", async () => {
    const { run } = await setup();
    const controller = new AbortController();
    let entered!: () => void;
    const inHook = new Promise<void>((r) => (entered = r));
    const stream = run({
      signal: controller.signal,
      onPayload: () => {
        entered();
        return new Promise(() => {}); // never settles
      },
    });
    const done = drain(stream);
    await inHook;
    controller.abort();
    await Promise.race([
      done,
      tick(5000).then(() => {
        throw new Error("stream did not end after abort");
      }),
    ]);
    await tick(100);
    expect(upstream!.requests).toHaveLength(0);
  });
});

describe("onResponse", () => {
  it("receives the real upstream status and headers before the body is delivered", async () => {
    const { run, model } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: { status: number; headers: Record<string, string> }[] = [];
    const models: unknown[] = [];
    const stream = run({
      onResponse: async (response: any, m: unknown) => {
        calls.push(response);
        models.push(m);
        await gate;
      },
    });
    const done = drain(stream);
    await tick(400);
    expect(calls).toHaveLength(1);
    expect(models[0]).toBe(model);
    expect(calls[0].status).toBe(200);
    expect(calls[0].headers["content-type"]).toBe("application/json");
    expect(JSON.stringify(calls[0])).not.toContain("fake-oauth-token");
    // Body (and so every normalized event) is held while the hook is pending.
    let finished = false;
    void done.then(() => (finished = true));
    await tick(300);
    expect(finished).toBe(false);
    release();
    const events = await done;
    expect(
      events
        .filter((e) => e.type === "text_delta")
        .map((e: any) => e.delta)
        .join(""),
    ).toBe(NORMAL_TEXT);
  });

  it("reports an upstream error status and its headers", async () => {
    const { run } = await setup(["429"]);
    const calls: any[] = [];
    await drain(run({ onResponse: (r: unknown) => void calls.push(r) }));
    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe(429);
    expect(calls[0].headers["retry-after"]).toBe("30");
  });

  it("is not called when no HTTP response exists (CLI login failure)", async () => {
    process.env.FAKE_CLAUDE_NOT_LOGGED_IN = "1";
    const { run } = await setup();
    const onResponse = vi.fn();
    await drain(run({ onResponse }));
    expect(onResponse).not.toHaveBeenCalled();
    expect(upstream!.requests).toHaveLength(0);
  });

  it("is not called for a rejected second generation", async () => {
    process.env.FAKE_CLAUDE_EXTRA_GENERATIONS = "1";
    const { run } = await setup();
    const onResponse = vi.fn();
    try {
      await drain(run({ onResponse }));
    } finally {
      delete process.env.FAKE_CLAUDE_EXTRA_GENERATIONS;
    }
    expect(onResponse).toHaveBeenCalledOnce();
    expect(upstream!.requests).toHaveLength(1);
  });
});

describe("onProviderStreamEvent", () => {
  it("sees parsed top-level CLI stream events in order, before normalization", async () => {
    const { run, model } = await setup();
    const seen: any[] = [];
    const models: unknown[] = [];
    const order: string[] = [];
    const stream = run({
      onProviderStreamEvent: (data: any, m: unknown) => {
        seen.push(data);
        models.push(m);
        order.push(`observe:${data.type}`);
      },
    });
    const events: AssistantMessageEvent[] = [];
    for await (const e of stream) {
      order.push(`pi:${e.type}`);
      events.push(e);
    }
    expect(seen.map((d) => d.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(models.every((m) => m === model)).toBe(true);
    // No control requests, system init or result summaries are invented in.
    expect(JSON.stringify(seen)).not.toContain('"result"');
    // The observer for text_delta data ran before Pi saw the text_delta.
    expect(order.indexOf("observe:content_block_delta")).toBeLessThan(
      order.indexOf("pi:text_delta"),
    );
  });

  it("holds normalized events while an observer is pending, then resumes in order", async () => {
    const { run } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const observed: string[] = [];
    const stream = run({
      onProviderStreamEvent: async (data: any) => {
        observed.push(data.type);
        if (data.type === "content_block_delta") await gate;
      },
    });
    const piEvents: string[] = [];
    const done = (async () => {
      for await (const e of stream) piEvents.push(e.type);
    })();
    await tick(500);
    // Observer is stuck on the delta: nothing after it was observed or shown.
    expect(observed.at(-1)).toBe("content_block_delta");
    expect(piEvents).not.toContain("text_delta");
    expect(piEvents).not.toContain("done");
    release();
    await done;
    expect(observed.at(-1)).toBe("message_stop");
    expect(piEvents.at(-1)).toBe("done");
  });

  it("stops promptly when cancelled during a pending observer", async () => {
    const { run } = await setup();
    const controller = new AbortController();
    let entered!: () => void;
    const inHook = new Promise<void>((r) => (entered = r));
    const piEvents: string[] = [];
    const done = (async () => {
      for await (const e of run({
        signal: controller.signal,
        onProviderStreamEvent: () => {
          entered();
          return new Promise(() => {});
        },
      }))
        piEvents.push(e.type);
    })();
    await inHook;
    controller.abort();
    await Promise.race([
      done,
      tick(5000).then(() => {
        throw new Error("stream did not end after abort");
      }),
    ]);
    // Buffered output must not be normalized after cancellation.
    expect(piEvents).not.toContain("text_delta");
  });
});

describe("hook privacy", () => {
  it("adds no prompt text or authorization to default logs when hooks are supplied", async () => {
    const spies = [
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "log").mockImplementation(() => {}),
    ];
    const { run } = await setup();
    await drain(
      run({
        onPayload: () => undefined,
        onResponse: () => undefined,
        onProviderStreamEvent: () => undefined,
      }),
    );
    const logged = spies
      .flatMap((s) => s.mock.calls)
      .map((args) => args.map((a) => JSON.stringify(a)).join(" "))
      .join("\n");
    expect(logged).not.toContain(SECRET_PROMPT);
    expect(logged).not.toContain("fake-oauth-token");
    expect(logged).not.toMatch(/authorization/i);
  });
});
