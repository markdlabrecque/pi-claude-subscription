import { describe, it, expect, afterEach, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { streamViaCli } from "../src/provider";
import { startRelay } from "../src/relay";
import {
  startFakeUpstream,
  installFakeClaude,
  type FakeUpstream,
  type FakeClaude,
  type Scenario,
  model,
} from "./harness";

// Issue #36: what the one-request guard does to the CLI's own retries and
// output-limit continuations. These document current behaviour; the cap stays.

let upstream: FakeUpstream | undefined;
let claude: FakeClaude | undefined;

afterEach(async () => {
  claude?.restore();
  delete process.env.FAKE_CLAUDE_CONTINUE_ON_MAX_TOKENS;
  await upstream?.close();
  claude = upstream = undefined;
  vi.restoreAllMocks();
});

async function runTurn(scenarios: Scenario[]) {
  upstream = await startFakeUpstream(scenarios);
  claude = installFakeClaude(upstream.url);
  const logs: string[] = [];
  vi.spyOn(console, "error").mockImplementation((l) => logs.push(String(l)));
  const stream = streamViaCli(model, {
    messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
  });
  for await (const _ of stream);
  const message = (await stream.result()) as any;
  const rejected = logs.filter((l) => /rejected: one Messages/.test(l)).length;
  return { message, rejected, logs };
}

describe("one-request cap against CLI retries", () => {
  it("529 then 500: the retry is rejected locally and the user sees the 529", async () => {
    const { message, rejected } = await runTurn(["529", "500"]);

    expect(upstream!.requests).toHaveLength(1);
    expect(rejected).toBe(1);
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe("Claude API returned 529 (overloaded).");
  });

  // Finding (not a fix): when upstream drops mid-body the relay neither ends
  // nor closes the CLI's response, so the CLI never reaches a retry. A turn
  // driven through the fake CLI then waits forever, so this is checked at the
  // relay. The cut-off is not recorded as a failure either.
  it("a cut-off upstream body leaves the CLI's response open; a later retry is still rejected", async () => {
    upstream = await startFakeUpstream(["cut_off", "normal"]);
    const relay = await startRelay({ upstream: upstream.url, log: () => {} });
    try {
      const first = await fetch(`${relay.url}/v1/messages`, {
        method: "POST",
        body: "{}",
      });
      const body = first.text().then(
        () => "ended",
        () => "errored",
      );
      const state = await Promise.race([
        body,
        new Promise((r) => setTimeout(() => r("still open"), 500)),
      ]);
      const retry = await fetch(`${relay.url}/v1/messages`, {
        method: "POST",
        body: "{}",
      });

      expect(state).toBe("still open");
      expect(relay.failure).toBeUndefined();
      expect(retry.status).toBe(400);
      expect(upstream.requests).toHaveLength(1);
      expect(relay.upstreamCount).toBe(1);
      expect(relay.rejectedCount).toBe(1);
    } finally {
      await relay.stop();
    }
  });

  it("max_tokens ends as a length completion and a continuation is rejected", async () => {
    process.env.FAKE_CLAUDE_CONTINUE_ON_MAX_TOKENS = "1";
    const { message, rejected } = await runTurn(["max_tokens", "normal"]);

    expect(upstream!.requests).toHaveLength(1);
    expect(rejected).toBe(1);
    expect(message.stopReason).toBe("length");
    expect(message.errorMessage).toBeUndefined();
    expect(message.content).toEqual([
      { type: "text", text: "A reply cut short by the output limit" },
    ]);
  });
});

describe("ADR for the one-request cap", () => {
  it("drafts a Proposed ADR covering the three cases and the three options", () => {
    const dir = join(__dirname, "..", "docs", "adr");
    const texts = readdirSync(dir)
      .filter((f) => f.endsWith(".md") && !f.startsWith("0001-"))
      .map((f) => readFileSync(join(dir, f), "utf-8"));
    const adr = texts.find((t) => /one[- ]request|retr(y|ies)/i.test(t));

    expect(adr).toBeDefined();
    expect(adr).toMatch(/status:?\**\s*proposed/i);
    for (const needle of [/529/, /cut.?off/i, /max_tokens/]) {
      expect(adr).toMatch(needle);
    }
    for (const option of [
      /keep the hard cap/i,
      /failed upstream responses?/i,
      /continuations?/i,
    ]) {
      expect(adr).toMatch(option);
    }
  });
});
