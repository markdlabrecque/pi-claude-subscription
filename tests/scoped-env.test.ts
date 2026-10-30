import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeContext, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  installFakeClaude,
  startFakeUpstream,
  NORMAL_TEXT,
  type FakeClaude,
  type FakeUpstream,
  type Scenario,
} from "./harness";

const SECRET = "sk-ant-synthetic-secret-do-not-log";

let claude: FakeClaude | undefined;
let upstreams: FakeUpstream[] = [];
let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "scoped-env-test-"));
  vi.stubEnv("TMPDIR", sandbox);
  vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_API_KEY_FALLBACK", "0");
});

afterEach(async () => {
  claude?.restore();
  await Promise.all(upstreams.map((u) => u.close()));
  claude = undefined;
  upstreams = [];
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(sandbox, { recursive: true, force: true });
});

async function upstreamFor(...scenarios: Scenario[]) {
  const u = await startFakeUpstream(scenarios.length ? scenarios : ["normal"]);
  upstreams.push(u);
  return u;
}

/** Register the extension and return a caller for the registered streamSimple. */
async function registered() {
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
  return (options?: Record<string, unknown>) => {
    const context = normalizeContext({
      messages: [{ role: "user", content: "Hello", timestamp: 1 }],
    });
    return config.streamSimple(model, context, options);
  };
}

const fakeEnv = (u: FakeUpstream) => (u.requests[0].body as any).fake_env;
const fakeArgs = (u: FakeUpstream) => (u.requests[0].body as any).fake_args;

describe("scoped provider environment", () => {
  it("overrides process values for one request, inherits the rest, and leaves no trace", async () => {
    const upstream = await upstreamFor();
    claude = installFakeClaude(upstream.url);
    vi.stubEnv("PI_TEST_MARKER", "from-process");
    vi.stubEnv("PI_TEST_INHERITED", "from-process-too");
    const stream = await registered();
    const env = { PI_TEST_MARKER: "scoped" };
    const processBefore = { ...process.env };

    await stream({ env }).result();

    expect(fakeEnv(upstream).markers).toEqual({
      PI_TEST_MARKER: "scoped",
      PI_TEST_INHERITED: "from-process-too",
    });
    expect(env).toEqual({ PI_TEST_MARKER: "scoped" });
    expect({ ...process.env }).toEqual(processBefore);

    await stream().result();
    expect(upstream.requests).toHaveLength(2);
    expect(
      (upstream.requests[1].body as any).fake_env.markers.PI_TEST_MARKER,
    ).toBe("from-process");
  });

  it("keeps concurrent requests' markers and endpoints apart", async () => {
    const [a, b, c] = await Promise.all([
      upstreamFor(),
      upstreamFor(),
      upstreamFor(),
    ]);
    claude = installFakeClaude(a.url);
    const stream = await registered();

    const results = await Promise.all([
      stream({
        env: { ANTHROPIC_BASE_URL: b.url, PI_TEST_MARKER: "one" },
      }).result(),
      stream({
        env: { ANTHROPIC_BASE_URL: c.url, PI_TEST_MARKER: "two" },
      }).result(),
      stream().result(),
    ]);

    for (const r of results) expect(r.stopReason).toBe("stop");
    expect(a.requests).toHaveLength(1);
    expect(b.requests).toHaveLength(1);
    expect(c.requests).toHaveLength(1);
    expect(fakeEnv(b).markers.PI_TEST_MARKER).toBe("one");
    expect(fakeEnv(c).markers.PI_TEST_MARKER).toBe("two");
    expect(fakeEnv(a).markers.PI_TEST_MARKER).toBeUndefined();
  });

  it("routes the relay to a scoped ANTHROPIC_BASE_URL, never handing it to the CLI", async () => {
    const [processUp, scopedUp] = await Promise.all([
      upstreamFor(),
      upstreamFor(),
    ]);
    claude = installFakeClaude(processUp.url);
    const stream = await registered();

    const result = await stream({
      env: { ANTHROPIC_BASE_URL: scopedUp.url },
    }).result();

    expect(result.content).toMatchObject([{ text: NORMAL_TEXT }]);
    expect(processUp.requests).toHaveLength(0);
    expect(scopedUp.requests).toHaveLength(1);
    const cliBase: string = fakeEnv(scopedUp).baseUrl;
    expect(cliBase).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(cliBase).not.toBe(scopedUp.url);
    expect(cliBase).not.toBe(processUp.url);
  });

  it("applies a scoped session mode to that request only", async () => {
    // Scoped "resume" makes the first turn create a CLI session; replay (the
    // default) leaves none.
    const upstream = await upstreamFor();
    claude = installFakeClaude(upstream.url);
    const stream = await registered();

    await stream({
      sessionId: "scoped-session",
      env: { PI_CLAUDE_SUBSCRIPTION_SESSION_MODE: "resume" },
    }).result();
    await stream({ sessionId: "other-session" }).result();

    expect(fakeArgs(upstream)).toContain("--session-id");
    expect((upstream.requests[1].body as any).fake_args).toContain(
      "--no-session-persistence",
    );
  });

  it("applies a scoped request timeout", async () => {
    const upstream = await upstreamFor("hang");
    claude = installFakeClaude(upstream.url);
    const stream = await registered();

    const result = await stream({
      env: { PI_CLAUDE_SUBSCRIPTION_TIMEOUT_MS: "400" },
    }).result();

    expect(JSON.stringify(result.content)).toContain("timed out");
  });
});

describe("scoped environment cannot weaken the subscription CLI", () => {
  it("keeps credentials, provider selectors and isolation out of scoped reach", async () => {
    const upstream = await upstreamFor();
    claude = installFakeClaude(upstream.url);
    const logged = [
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "info").mockImplementation(() => {}),
    ];
    const stream = await registered();

    const result = await stream({
      env: {
        ANTHROPIC_API_KEY: SECRET,
        ANTHROPIC_AUTH_TOKEN: SECRET,
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_USE_VERTEX: "1",
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: "0",
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "0",
      },
    }).result();

    // Still the subscription CLI behind the relay, not the API-key fallback
    expect(result.content).toMatchObject([{ text: NORMAL_TEXT }]);
    expect(upstream.requests).toHaveLength(1);
    const env = fakeEnv(upstream);
    expect(env.forbiddenPresent).toEqual([]);
    expect(env.disableClaudeMds).toBe("1");
    expect(env.disableAutoMemory).toBe("1");
    expect(env.nonessentialTraffic).toBe("1");
    expect(JSON.stringify(upstream.requests)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    for (const spy of logged) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
    }
  });
});

describe("abort through the registered provider", () => {
  it("starts nothing when the signal is already aborted", async () => {
    const upstream = await upstreamFor();
    claude = installFakeClaude(upstream.url);
    const record = join(sandbox, "record.json");
    vi.stubEnv("FAKE_CLAUDE_RECORD_FILE", record);
    const stream = await registered();
    const controller = new AbortController();
    controller.abort();

    await stream({ signal: controller.signal }).result();

    expect(upstream.requests).toHaveLength(0);
    expect(existsSync(record)).toBe(false);
  });

  it("kills the CLI tree and frees the relay when aborted mid-request", async () => {
    const upstream = await upstreamFor("hang");
    claude = installFakeClaude(upstream.url);
    const record = join(sandbox, "record.json");
    vi.stubEnv("FAKE_CLAUDE_RECORD_FILE", record);
    const stream = await registered();
    const controller = new AbortController();

    const pending = stream({
      signal: controller.signal,
      env: { PI_TEST_MARKER: "abort" },
    }).result();
    await vi.waitFor(() => expect(upstream.requests).toHaveLength(1));
    controller.abort();
    await pending;

    const { pids, baseUrl } = JSON.parse(readFileSync(record, "utf-8"));
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await vi.waitFor(() => {
      for (const pid of pids) expect(alive(pid)).toBe(false);
    });
    await expect(fetch(baseUrl)).rejects.toThrow();
  });
});
