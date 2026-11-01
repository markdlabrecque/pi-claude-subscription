import { afterEach, expect, it, vi } from "vitest";
import { getCurrentTools, normalizeContext, Type } from "@earendil-works/pi-ai";
import { streamViaCli } from "../src/provider";
import { toMcpToolDefs, writeMcpConfig } from "../src/mcp-config";
import {
  installFakeClaude,
  startFakeUpstream,
  model,
  type FakeClaude,
  type FakeUpstream,
} from "./harness";

let upstream: FakeUpstream | undefined;
let claude: FakeClaude | undefined;
afterEach(async () => {
  claude?.restore();
  await upstream?.close();
  claude = upstream = undefined;
  vi.unstubAllEnvs();
});

it.each([false, true])(
  "preserves the cached request prefix at the first tool result, earlier text reply: %s",
  async (earlierTextReply) => {
    upstream = await startFakeUpstream(
      earlierTextReply
        ? ["normal", "t3_code_tool", "echo_tool_result"]
        : ["t3_code_tool", "echo_tool_result"],
    );
    claude = installFakeClaude(upstream.url);
    vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_SESSION_MODE", "replay");
    const tools = [
      {
        name: "mcp__t3-code__link_pull_request",
        description: "Link a pull request",
        parameters: Type.Object({ path: Type.String() }),
      },
    ];
    const context = normalizeContext({
      systemPrompt: "Keep Pi instructions and tool history intact.",
      tools,
      messages: [{ role: "user", content: "Link the PR", timestamp: 1 }],
    });
    expect("tools" in context).toBe(false);
    async function request() {
      return streamViaCli(model, context, {
        mcpConfigPath: writeMcpConfig(
          toMcpToolDefs(getCurrentTools(context.messages)),
        ),
      }).result();
    }
    if (earlierTextReply) {
      const reply = await request();
      expect(reply.stopReason).toBe("stop");
      context.messages.push(reply, {
        role: "user",
        content: "Now call the tool",
        timestamp: 2,
      });
    }
    const reply = await request();
    expect(reply.stopReason).toBe("toolUse");
    const call = reply.content[0];
    if (call.type !== "toolCall") throw new Error("Expected a tool call");
    context.messages.push(reply, {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: "PR-LINKED" }],
      isError: false,
      timestamp: 3,
    });
    const continued = await request();
    expect(continued.stopReason).toBe("stop");
    expect(JSON.stringify(continued.content)).toContain("PR-LINKED");
    expect(upstream.requests).toHaveLength(earlierTextReply ? 3 : 2);
    const [before, after] = upstream.requests
      .slice(-2)
      .map((r) => r.body as any);
    // Cache-control placement is CLI-owned. The fake CLI adds none here.
    expect(after.system).toEqual(before.system);
    expect(after.tools).toEqual(before.tools);
    expect(
      after.messages[0].content.slice(0, before.messages[0].content.length),
    ).toEqual(before.messages[0].content);
    expect(JSON.stringify(after.messages)).toContain(call.name);
    expect(JSON.stringify(after.messages)).toContain("PR-LINKED");
  },
);
