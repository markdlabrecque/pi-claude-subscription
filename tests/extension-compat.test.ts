import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { streamViaCli } from "../src/provider";
import { getToolDefs } from "../src/mcp-config";
import {
  startFakeUpstream,
  installFakeClaude,
  type FakeUpstream,
  type FakeClaude,
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

// The `hello` extension ships in @earendil-works/pi-coding-agent's examples:
// the most real Pi extension with a custom tool that is installed here.
const pkgDir = join(
  __dirname,
  "..",
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
);
const helloPath = join(pkgDir, "examples", "extensions", "hello.ts");

describe("Pi extension compatibility", () => {
  it("runs a tool-using turn with a real extension's custom tool", async () => {
    const { extensions, errors } = await discoverAndLoadExtensions(
      [helloPath],
      pkgDir,
      join(pkgDir, "no-agent-dir"),
    );
    expect(errors).toEqual([]);
    const tools = [...extensions[0].tools.values()].map((t) => t.definition);
    expect(
      getToolDefs({ getAllTools: () => tools }).map((t) => t.name),
    ).toEqual(["hello"]);

    upstream = await startFakeUpstream(["custom_tool", "normal"]);
    claude = installFakeClaude(upstream.url);

    const first = await run({
      messages: [{ role: "user", content: "Greet Pi", timestamp: 1 }],
    });
    const call = first.content[0];
    expect(first.stopReason).toBe("toolUse");
    expect(call).toMatchObject({
      type: "toolCall",
      name: "hello",
      arguments: { name: "Pi" },
    });

    // Pi runs the extension's own tool and feeds the result back.
    const result = await tools[0].execute(
      call.id,
      call.arguments,
      undefined,
      undefined,
      undefined as any,
    );
    const second = await run({
      messages: [
        { role: "user", content: "Greet Pi", timestamp: 1 },
        first,
        {
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: result.content,
          isError: false,
          timestamp: 2,
        },
      ],
    });

    expect(second.stopReason).toBe("stop");
    expect(JSON.stringify(upstream.requests[1].body)).toContain("Hello, Pi!");
  });
});
