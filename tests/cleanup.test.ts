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
  "FAKE_CLAUDE_PARTIAL_HANG",
  "FAKE_CLAUDE_PARTIAL_TEXT",
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

/**
 * Run one turn against the fake upstream. `cancel` has Pi cancel once the
 * CLI's request is upstream, or once partial text has streamed.
 */
async function runTurn(
  scenario: Scenario,
  cancel?: "after-request" | "after-text",
) {
  upstream = await startFakeUpstream([scenario]);
  claude = installFakeClaude(upstream.url);
  const controller = new AbortController();
  const stream = streamViaCli(
    model,
    { messages: [{ role: "user", content: "Say hello", timestamp: 1 }] },
    { signal: controller.signal, mcpConfigPath: writeMcpConfig([]) },
  );
  if (cancel === "after-request") {
    await vi.waitFor(() => expect(upstream!.requests).toHaveLength(1));
    controller.abort();
  }
  const terminals: any[] = [];
  for await (const event of stream) {
    if (event.type === "done" || event.type === "error") terminals.push(event);
    if (cancel === "after-text" && event.type === "text_delta") {
      controller.abort();
    }
  }
  const message: any = await stream.result();
  return { message, terminals };
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
    const { message } = await runTurn(scenario);

    expect(message.stopReason).toBe("error");
    await expectNothingLeft();
  });

  it("after the timeout kills a hung CLI", async () => {
    process.env.PI_CLAUDE_SUBSCRIPTION_TIMEOUT_MS = "500";

    const { message } = await runTurn("hang");

    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("timed out");
    await expectNothingLeft();
  });

  it("after Pi cancels", async () => {
    const { message, terminals } = await runTurn("hang", "after-request");

    expect(terminals).toHaveLength(1);
    expect(terminals[0].type).toBe("error");
    expect(terminals[0].reason).toBe("aborted");
    expect(terminals[0].error).toEqual(message);
    expect(message.stopReason).toBe("aborted");
    expect(message.errorMessage).toBeTruthy();
    expect(message.content).toEqual([]);
    await expectNothingLeft();
  });

  it("after Pi cancels a reply that has partial text", async () => {
    process.env.FAKE_CLAUDE_PARTIAL_HANG = "1";
    process.env.FAKE_CLAUDE_PARTIAL_TEXT = "Half a sentence";

    const { message, terminals } = await runTurn("normal", "after-text");

    expect(terminals).toHaveLength(1);
    expect(terminals[0].type).toBe("error");
    expect(terminals[0].reason).toBe("aborted");
    expect(terminals[0].error).toEqual(message);
    expect(message.stopReason).toBe("aborted");
    expect(message.errorMessage).toBeTruthy();
    expect(message.content).toEqual([
      expect.objectContaining({ type: "text", text: "Half a sentence" }),
    ]);
    expect(message.usage.input).toBe(10);
    await expectNothingLeft();
  });
});
