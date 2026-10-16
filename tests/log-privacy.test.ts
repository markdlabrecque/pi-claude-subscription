import { describe, it, expect, afterEach, vi } from "vitest";
import { parseLine } from "../src/stream-parser";
import { handleControlRequest } from "../src/control-handler";
import { startRelay, type Relay } from "../src/relay";
import { startFakeUpstream, type FakeUpstream } from "./harness";
import { DEBUG_ENV } from "../src/debug-log";

const SECRET = "SECRET-PROMPT-TEXT";

let relay: Relay | undefined;
let upstream: FakeUpstream | undefined;

afterEach(async () => {
  delete process.env[DEBUG_ENV];
  await relay?.stop();
  await upstream?.close();
  relay = upstream = undefined;
  vi.restoreAllMocks();
});

/** Everything the code under test wrote to the console, as one string. */
function captureConsole(): () => string {
  const spies = [
    vi.spyOn(console, "error").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
    vi.spyOn(console, "log").mockImplementation(() => {}),
  ];
  return () =>
    spies
      .flatMap((s) => s.mock.calls)
      .map((args) => args.map((a) => JSON.stringify(a)).join(" "))
      .join("\n");
}

describe("log privacy", () => {
  it("keeps prompt text and tool arguments out of default logs, and adds them under the debug flag", () => {
    const output = captureConsole();
    const badLine = `{"text":"${SECRET}"`;
    const malformed = {
      type: "control_request",
      request: {
        subtype: "can_use_tool",
        tool_name: "x",
        input: { a: SECRET },
      },
    } as any;

    parseLine(badLine);
    handleControlRequest(malformed, { write: () => true } as any);
    expect(output()).not.toContain(SECRET);

    process.env[DEBUG_ENV] = "1";
    parseLine(badLine);
    handleControlRequest(malformed, { write: () => true } as any);
    expect(output()).toContain(SECRET);
  });

  it("logs relay request lines only under the debug flag, never auth headers", async () => {
    upstream = await startFakeUpstream(["normal"]);
    const lines: string[] = [];
    relay = await startRelay({
      upstream: upstream.url,
      log: (l) => lines.push(l),
    });
    const hit = () =>
      fetch(`${relay!.url}/v1/other?token=abc`, {
        headers: { authorization: "Bearer secret-token" },
      });

    await hit();
    const defaultLines = lines.length;

    process.env[DEBUG_ENV] = "1";
    await hit();

    expect(lines.length).toBeGreaterThan(defaultLines * 2);
    expect(lines.join("\n")).not.toMatch(/secret-token|token=abc/);
  });
});
