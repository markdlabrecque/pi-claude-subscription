import { describe, it, expect, afterEach } from "vitest";
import { streamViaCli } from "../src/provider";
import {
  startFakeUpstream,
  installFakeClaude,
  type FakeUpstream,
  type FakeClaude,
  type Scenario,
} from "./harness";

const model: any = {
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  api: "anthropic-messages",
  provider: "pi-claude-subscription",
  reasoning: false,
  input: ["text"],
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  contextWindow: 200000,
  maxTokens: 8192,
};

let upstream: FakeUpstream | undefined;
let claude: FakeClaude | undefined;

afterEach(async () => {
  claude?.restore();
  await upstream?.close();
  claude = upstream = undefined;
});

async function run(context: any) {
  const stream = streamViaCli(model, context);
  for await (const _ of stream);
  return (await stream.result()) as any;
}

describe("tool call outside the offered inventory", () => {
  it.each<Scenario>(["made_up_tool", "made_up_mcp_tool"])(
    "%s reaches Pi as a bare tool call, and Pi's error drives a retry",
    async (scenario) => {
      upstream = await startFakeUpstream([scenario, "normal"]);
      claude = installFakeClaude(upstream.url);

      const first = await run({
        messages: [{ role: "user", content: "Do it", timestamp: 1 }],
      });

      expect(first.stopReason).toBe("toolUse");
      expect(first.content).toEqual([
        {
          type: "toolCall",
          id: "toolu_fake",
          name: "totally_made_up_tool",
          arguments: { path: "a.txt" },
        },
      ]);

      const second = await run({
        messages: [
          { role: "user", content: "Do it", timestamp: 1 },
          first,
          {
            role: "toolResult",
            toolCallId: "toolu_fake",
            toolName: "totally_made_up_tool",
            content: [
              {
                type: "text",
                text: "Tool totally_made_up_tool not found. Available tools: read, bash",
              },
            ],
            isError: true,
            timestamp: 2,
          },
        ],
      });

      expect(second.content).toEqual([
        { type: "text", text: "Hello from the fake upstream" },
      ]);
      expect(upstream.requests).toHaveLength(2);
      expect(JSON.stringify(upstream.requests[1].body)).toContain(
        "Available tools: read, bash",
      );
    },
  );
});
