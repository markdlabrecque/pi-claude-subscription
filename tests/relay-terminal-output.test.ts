import { describe, it, expect, afterEach, vi } from "vitest";
import { startRelay, type Relay } from "../src/relay";
import { startFakeUpstream, type FakeUpstream } from "./harness";

// Issue #96: Pi's fullscreen TUI owns the terminal, so anything the relay's
// default logger writes to stdout/stderr is drawn over the prompt editor.

let upstream: FakeUpstream | undefined;
let relay: Relay | undefined;

afterEach(async () => {
  await relay?.stop();
  await upstream?.close();
  relay = undefined;
  upstream = undefined;
  vi.restoreAllMocks();
});

describe("relay default diagnostics", () => {
  it("complete a request without writing to the terminal", async () => {
    const written: string[] = [];
    const capture = (chunk: unknown) => {
      written.push(String(chunk));
      return true;
    };
    const consoleCalls: string[] = [];
    const captureConsole = (...args: unknown[]) => {
      consoleCalls.push(args.map(String).join(" "));
    };

    upstream = await startFakeUpstream(["normal"]);
    // No `log` option: exercises the default diagnostic path.
    relay = await startRelay({ upstream: upstream.url });

    vi.spyOn(process.stderr, "write").mockImplementation(capture as never);
    vi.spyOn(process.stdout, "write").mockImplementation(capture as never);
    vi.spyOn(console, "error").mockImplementation(captureConsole);
    vi.spyOn(console, "warn").mockImplementation(captureConsole);
    vi.spyOn(console, "log").mockImplementation(captureConsole);
    vi.spyOn(console, "info").mockImplementation(captureConsole);

    const res = await fetch(`${relay.url}/v1/messages?beta=true`, {
      method: "POST",
      headers: { authorization: "Bearer secret-token" },
      body: "{}",
    });
    await res.text();

    expect(res.status).toBe(200);
    expect(relay.upstreamCount).toBe(1);
    expect(consoleCalls).toEqual([]);
    expect(written.join("")).not.toContain("[pi-claude-subscription]");
  });
});
