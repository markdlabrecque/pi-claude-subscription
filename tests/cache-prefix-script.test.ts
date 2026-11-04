import { execFileSync, spawn } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { installFakeClaude, type FakeClaude } from "./harness";

let claude: FakeClaude | undefined;
afterEach(() => {
  claude?.restore();
  claude = undefined;
});

it.each(["1", "later"])(
  "runs the complete offline check with reminder shape %s",
  (shape) => {
    // Only the fake CLI is on PATH. The script supplies its own loopback SSE
    // server and dummy login; no real CLI, credential or remote request is used.
    claude = installFakeClaude("http://127.0.0.1:1");
    const output = execFileSync(
      process.execPath,
      [
        "node_modules/vite-node/vite-node.mjs",
        "scripts/acceptance/cache-prefix.ts",
        "--model",
        "claude-haiku-4-5",
      ],
      {
        encoding: "utf8",
        stdio: "pipe",
        timeout: 15000,
        env: {
          ...process.env,
          FAKE_CLAUDE_ENVIRONMENT_REMINDER: shape,
          FAKE_CLAUDE_ACCEPTANCE_SHAPE: "1",
        },
      },
    );
    expect(output).toContain(
      "PASS: stable prefix through the real CLI, local responses only",
    );
    const records = output
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
    const diagnostics = records.filter((record) => record.diagnosticTurn);
    expect(diagnostics).toHaveLength(3);
    expect(
      diagnostics.every(
        (record) =>
          record.environmentNormalized &&
          record.completed &&
          record.upstreamCount === 1 &&
          record.rejectedCount === 0,
      ),
    ).toBe(true);
    const reservations = records.filter((record) => record.requestBytes);
    expect(reservations).toHaveLength(3);
    expect(
      reservations.every(
        (record) =>
          record.requestBytes <= 80_000 &&
          record.rawPrivatePathAbsent &&
          record.normalizedReminderObserved,
      ),
    ).toBe(true);
    expect(reservations[0].shapes).toEqual([
      shape === "1" ? "wrapped:messages[0]" : "unwrapped:messages[1]",
    ]);
    expect(records).toContainEqual({
      scratchCleanup: "confirmed",
      privateDirectoryCleanup: true,
    });
    expect(output).not.toContain("Primary working directory:");
    expect(output).not.toMatch(/pi-claude-subscription-[A-Za-z0-9]{6}/);
  },
);

it("cancels an in-flight offline check with SIGINT and cleans its private directories", async () => {
  claude = installFakeClaude("http://127.0.0.1:1");
  const result = await new Promise<{ code: number | null; output: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "node_modules/vite-node/vite-node.mjs",
          "scripts/acceptance/cache-prefix.ts",
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            FAKE_CLAUDE_ENVIRONMENT_REMINDER: "later",
            FAKE_CLAUDE_ACCEPTANCE_SHAPE: "1",
            FAKE_CLAUDE_STREAM_STOP_DELAY_MS: "60000",
          },
        },
      );
      let output = "";
      let signalled = false;
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("offline cancellation did not settle"));
      }, 15000);
      child.stdout.on("data", (data) => {
        output += String(data);
        if (!signalled && output.includes('"requestBytes"')) {
          signalled = true;
          child.kill("SIGINT");
        }
      });
      child.stderr.on("data", () => {});
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, output });
      });
    },
  );
  expect(result.code).toBe(1);
  expect(result.output).not.toContain("PASS:");
  expect(result.output).toContain('"cancelled":true');
  expect(result.output).toContain('"privateDirectoryCleanup":true');
}, 20000);
