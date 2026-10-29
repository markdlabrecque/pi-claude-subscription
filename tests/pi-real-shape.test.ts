import { describe, it, expect, afterEach } from "vitest";
import { streamViaCli } from "../src/provider";
import {
  startFakeUpstream,
  installFakeClaude,
  type FakeUpstream,
  type FakeClaude,
  model,
} from "./harness";

import * as piAi from "@earendil-works/pi-ai";

let upstream: FakeUpstream | undefined;
let claude: FakeClaude | undefined;
afterEach(async () => {
  claude?.restore();
  await upstream?.close();
  claude = upstream = undefined;
});

const tools = ["read", "mcp__t3-code__link_pull_request"].map((name) => ({
  name,
  description: name,
  parameters: piAi.Type.Object({ path: piAi.Type.String() }),
}));

async function run(context: any) {
  const stream = streamViaCli(model, context);
  for await (const _ of stream);
  return (await stream.result()) as any;
}

describe("context built by Pi's real normalizeContext", () => {
  it("has no context.tools, tools only in toolsAdded", () => {
    const ctx = piAi.normalizeContext({
      messages: [],
      systemPrompt: "s",
      tools,
    });
    expect("tools" in ctx).toBe(false);
    expect(piAi.getCurrentTools(ctx.messages)).toEqual(tools);
  });

  it("underscore call resolves to the hyphenated Pi tool", async () => {
    upstream = await startFakeUpstream(["t3_code_tool"]);
    claude = installFakeClaude(upstream.url);
    const ctx = piAi.normalizeContext({
      messages: [{ role: "user", content: "Link", timestamp: 1 }],
      tools,
    });
    const r = await run(ctx);
    expect(r.content[0].name).toBe("mcp__t3-code__link_pull_request");
  });

  it("repeated identical failure ends the turn within 3 requests", async () => {
    upstream = await startFakeUpstream(["made_up_tool"]);
    claude = installFakeClaude(upstream.url);
    const history: any[] = [{ role: "user", content: "Go", timestamp: 1 }];
    let r: any;
    for (let i = 0; i < 10; i++) {
      r = await run(piAi.normalizeContext({ messages: [...history], tools }));
      if (r.stopReason !== "toolUse") break;
      history.push(r, {
        role: "toolResult",
        toolCallId: r.content[0].id,
        toolName: r.content[0].name,
        content: [
          { type: "text", text: "Tool totally_made_up_tool not found" },
        ],
        isError: true,
        timestamp: 2,
      });
    }
    expect(upstream.requests).toHaveLength(3);
    expect(r.stopReason).toBe("stop");
  });

  it("underscore call with no matching Pi tool passes through unchanged", async () => {
    upstream = await startFakeUpstream(["t3_code_tool"]);
    claude = installFakeClaude(upstream.url);
    const ctx = piAi.normalizeContext({
      messages: [{ role: "user", content: "Link", timestamp: 1 }],
      tools: tools.slice(0, 1),
    });
    const r = await run(ctx);
    expect(r.content[0].name).toBe("mcp__t3_code__link_pull_request");
  });
});
