import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamViaCli } from "../src/provider";
import { writeMcpConfig } from "../src/mcp-config";
import {
  startFakeUpstream,
  installFakeClaude,
  type FakeUpstream,
  type FakeClaude,
  type Scenario,
  model,
} from "./harness";

const ENV_KEYS = [
  "TMPDIR",
  "FAKE_CLAUDE_RECORD_FILE",
  "PI_CLAUDE_SUBSCRIPTION_TIMEOUT_MS",
];

let upstream: FakeUpstream | undefined;
let claude: FakeClaude | undefined;
let sandbox: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  // A private TMPDIR, so only this test's temp directories are counted
  sandbox = mkdtempSync(join(tmpdir(), "cleanup-test-"));
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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Run one turn against the fake upstream; `afterStart` runs once the CLI is up. */
async function runTurn(
  scenario: Scenario,
  afterStart?: (abort: () => void) => void,
) {
  upstream = await startFakeUpstream([scenario]);
  claude = installFakeClaude(upstream.url);
  const controller = new AbortController();
  const stream = streamViaCli(
    model,
    { messages: [{ role: "user", content: "Say hello", timestamp: 1 }] },
    { signal: controller.signal, mcpConfigPath: writeMcpConfig([]) },
  );
  if (afterStart) {
    await vi.waitFor(() => expect(upstream!.requests).toHaveLength(1));
    afterStart(() => controller.abort());
  }
  return stream.result() as Promise<any>;
}

async function expectNothingLeft() {
  const record = JSON.parse(
    readFileSync(process.env.FAKE_CLAUDE_RECORD_FILE!, "utf-8"),
  );
  await vi.waitFor(() => {
    for (const pid of record.pids) expect(isAlive(pid)).toBe(false);
    expect(
      // Private working directories and MCP config files
      readdirSync(sandbox).filter((d) => d.startsWith("pi-claude-")),
    ).toEqual([]);
  });
  await expect(fetch(record.baseUrl)).rejects.toThrow();
}

describe("stopping a request leaves nothing behind", () => {
  it.each([
    ["auth error", "401"],
    ["rate limit", "429"],
  ] as const)("after %s", async (_name, scenario) => {
    const message = await runTurn(scenario);

    expect(message.stopReason).toBe("error");
    await expectNothingLeft();
  });

  it("after the timeout kills a hung CLI", async () => {
    process.env.PI_CLAUDE_SUBSCRIPTION_TIMEOUT_MS = "500";

    const message = await runTurn("hang");

    expect(message.content[0].text).toContain("timed out");
    await expectNothingLeft();
  });

  it("after Pi cancels", async () => {
    await runTurn("hang", (abort) => abort());

    await expectNothingLeft();
  });
});
