import { describe, it, expect, afterEach } from "vitest";
import { streamViaCli } from "../src/provider";
import {
  startFakeUpstream,
  installFakeClaude,
  type FakeUpstream,
  type FakeClaude,
  type Scenario,
  model,
} from "./harness";

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

describe("custom tool whose pi name contains mcp__ (#26)", () => {
  const tools = [{ name: "read" }, { name: "mcp__t3-code__link_pull_request" }];

  it("resolves an underscore-spelled call to the registered pi tool", async () => {
    upstream = await startFakeUpstream(["t3_code_tool"]);
    claude = installFakeClaude(upstream.url);

    const result = await run({
      messages: [{ role: "user", content: "Link it", timestamp: 1 }],
      tools,
    });

    expect(result.content[0].name).toBe("mcp__t3-code__link_pull_request");
  });

  it("resolves the name from the system message's toolsAdded, as Pi passes it (no context.tools)", async () => {
    upstream = await startFakeUpstream(["t3_code_tool"]);
    claude = installFakeClaude(upstream.url);

    const result = await run({
      messages: [
        { role: "system", content: "", toolsAdded: tools, timestamp: 0 },
        { role: "user", content: "Link it", timestamp: 1 },
      ],
    });

    expect(result.content[0].name).toBe("mcp__t3-code__link_pull_request");
  });

  it("stops a model that keeps re-issuing the same failing call", async () => {
    upstream = await startFakeUpstream(["made_up_tool"]);
    claude = installFakeClaude(upstream.url);

    const messages: any[] = [{ role: "user", content: "Yes", timestamp: 1 }];
    let result: any;
    for (let turn = 0; turn < 10; turn++) {
      result = await run({ messages, tools });
      if (result.stopReason !== "toolUse") break;
      messages.push(result, {
        role: "toolResult",
        toolCallId: result.content[0].id,
        toolName: result.content[0].name,
        content: [
          { type: "text", text: "Tool totally_made_up_tool not found" },
        ],
        isError: true,
        timestamp: 2,
      });
    }

    expect(upstream.requests).toHaveLength(3);
    expect(result.stopReason).toBe("stop");
    expect(result.content[0].text).toMatch(
      /totally_made_up_tool failed 3 times in a row/,
    );
  });
});
