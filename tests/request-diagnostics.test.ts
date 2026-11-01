import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { streamViaCli } from "../src/provider";
import { DEBUG_ENV } from "../src/debug-log";
import { writeMcpConfig } from "../src/mcp-config";
import {
  startFakeUpstream,
  installFakeClaude,
  type FakeUpstream,
  type FakeClaude,
  model,
} from "./harness";

const PROMPT_MARKER = "SYNTHETIC-PROMPT-MARKER";
const OUTPUT_MARKER = "SYNTHETIC-PARTIAL-OUTPUT-MARKER";
const STDERR_MARKER = "SYNTHETIC-STDERR-MARKER";
const TOKEN_MARKER = "fake-oauth-token";
const MARKERS = [PROMPT_MARKER, OUTPUT_MARKER, TOKEN_MARKER];

const ENV_KEYS = [
  DEBUG_ENV,
  "FAKE_CLAUDE_EMPTY_EXIT",
  "FAKE_CLAUDE_PARTIAL_FAIL",
  "FAKE_CLAUDE_PARTIAL_TEXT",
  "PI_CLAUDE_SUBSCRIPTION_TIMEOUT_MS",
];

let upstream: FakeUpstream | undefined;
let claude: FakeClaude | undefined;
let saved: Record<string, string | undefined>;
let consoleCalls: () => string[];

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const spies = (["error", "warn", "log"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
  consoleCalls = () =>
    spies
      .flatMap((s) => s.mock.calls)
      .map((args) =>
        args
          .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
          .join(" "),
      );
});

afterEach(async () => {
  claude?.restore();
  await upstream?.close();
  claude = upstream = undefined;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

/** Run one turn against the fake CLI; `abortAfterStart` cancels once it is up. */
async function runTurn(opts: { abortAfterStart?: boolean } = {}) {
  upstream = await startFakeUpstream([
    opts.abortAfterStart ? "hang" : "normal",
  ]);
  claude = installFakeClaude(upstream.url);
  const controller = new AbortController();
  const stream = streamViaCli(
    model,
    { messages: [{ role: "user", content: PROMPT_MARKER, timestamp: 1 }] },
    { signal: controller.signal, mcpConfigPath: writeMcpConfig([]) },
  );
  if (opts.abortAfterStart) {
    await vi.waitFor(() => expect(upstream!.requests).toHaveLength(1));
    controller.abort();
  }
  await stream.result();
}

/**
 * The per-request diagnostic record: a single-line JSON object with a
 * `requestId`, written to the console once per request.
 */
async function diagnostics(): Promise<Record<string, any>[]> {
  const found: Record<string, any>[] = [];
  await vi.waitFor(() => {
    found.length = 0;
    for (const line of consoleCalls()) {
      const start = line.indexOf("{");
      const end = line.lastIndexOf("}");
      if (start < 0 || end < start) continue;
      try {
        const record = JSON.parse(line.slice(start, end + 1));
        if (record && "requestId" in record) found.push(record);
      } catch {
        // not a diagnostic record
      }
    }
    expect(found).toHaveLength(1);
  });
  return [...found];
}

function expectNoLeaks() {
  const all = consoleCalls().join("\n");
  for (const marker of MARKERS) expect(all).not.toContain(marker);
}

describe("request diagnostics", () => {
  it("writes nothing extra at the default level and no secrets or content anywhere", async () => {
    process.env.FAKE_CLAUDE_PARTIAL_FAIL = STDERR_MARKER;
    process.env.FAKE_CLAUDE_PARTIAL_TEXT = OUTPUT_MARKER;

    await runTurn();

    expect(consoleCalls().filter((l) => l.includes("requestId"))).toEqual([]);
    expectNoLeaks();
  });

  it("records versions and a completed turn under the debug flag", async () => {
    process.env[DEBUG_ENV] = "1";

    await runTurn();

    const [d] = await diagnostics();
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
    );
    expect(d.extensionVersion).toBe(pkg.version);
    expect(d.piVersion).toMatch(/^1\.\d+\.\d+/);
    expect(d.cliVersion).toBe("2.1.312");
    expect(typeof d.requestId).toBe("string");
    expect(d.requestId).not.toBe("");
    expect(d).toMatchObject({
      sawMessageStart: true,
      sawMessageStop: true,
      sawResult: true,
      exitCode: 0,
      cancelled: false,
      timedOut: false,
      upstreamCount: 1,
      rejectedCount: 0,
    });
    expectNoLeaks();
  });

  it("tells an empty exit from a partial-output failure and a cancellation", async () => {
    process.env[DEBUG_ENV] = "1";
    const records: Record<string, any>[] = [];

    // Empty exit: the CLI exits 0 having sent nothing
    process.env.FAKE_CLAUDE_EMPTY_EXIT = "1";
    await runTurn();
    records.push((await diagnostics())[0]);
    expect(records[0]).toMatchObject({
      sawMessageStart: false,
      sawMessageStop: false,
      sawResult: false,
      exitCode: 0,
      cancelled: false,
      upstreamCount: 0,
    });
    claude?.restore();
    await upstream?.close();
    delete process.env.FAKE_CLAUDE_EMPTY_EXIT;
    vi.mocked(console.error).mockClear();

    // Partial output, then a crash
    process.env.FAKE_CLAUDE_PARTIAL_FAIL = STDERR_MARKER;
    process.env.FAKE_CLAUDE_PARTIAL_TEXT = OUTPUT_MARKER;
    await runTurn();
    records.push((await diagnostics())[0]);
    expect(records[1]).toMatchObject({
      sawMessageStart: true,
      sawMessageStop: false,
      sawResult: false,
      exitCode: 1,
      cancelled: false,
      upstreamCount: 1,
    });
    claude?.restore();
    await upstream?.close();
    delete process.env.FAKE_CLAUDE_PARTIAL_FAIL;
    vi.mocked(console.error).mockClear();

    // Cancelled by Pi
    await runTurn({ abortAfterStart: true });
    records.push((await diagnostics())[0]);
    expect(records[2]).toMatchObject({
      cancelled: true,
      timedOut: false,
      sawResult: false,
    });

    // Each case is told apart, and each request is identified separately
    expect(new Set(records.map((r) => r.terminalReason)).size).toBe(3);
    for (const r of records) expect(typeof r.terminalReason).toBe("string");
    expect(new Set(records.map((r) => r.requestId)).size).toBe(3);
    // The stderr marker was shown to the user as the error, but never logged
    expect(consoleCalls().join("\n")).not.toContain(STDERR_MARKER);
    expectNoLeaks();
  });

  it("flags a request timeout", async () => {
    process.env[DEBUG_ENV] = "1";
    process.env.PI_CLAUDE_SUBSCRIPTION_TIMEOUT_MS = "500";
    upstream = await startFakeUpstream(["hang"]);
    claude = installFakeClaude(upstream.url);

    await streamViaCli(
      model,
      { messages: [{ role: "user", content: PROMPT_MARKER, timestamp: 1 }] },
      { mcpConfigPath: writeMcpConfig([]) },
    ).result();

    const [d] = await diagnostics();
    expect(d).toMatchObject({ timedOut: true, cancelled: false });
    expectNoLeaks();
  });
});
