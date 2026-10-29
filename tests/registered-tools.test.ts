import { afterEach, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Api,
  AssistantMessageEvent,
  Model,
  SimpleStreamOptions,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import {
  installFakeClaude,
  startFakeUpstream,
  type FakeClaude,
  type FakeUpstream,
} from "./harness";

const TOOL_NAME = "mcp__t3-code__link_pull_request";
const MARKERS = ["HOST-CLAUDE-MD", "HOST-SKILL", "HOST-HOOK", "WORKSPACE-MD"];
let sandbox: string | undefined;
let claude: FakeClaude | undefined;
let upstream: FakeUpstream | undefined;

afterEach(async () => {
  claude?.restore();
  await upstream?.close();
  vi.unstubAllEnvs();
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  claude = undefined;
  upstream = undefined;
  sandbox = undefined;
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

it("executes a stable offered tool on the Pi side and replays its result through the registered provider", async () => {
  // index.ts caches the inventory. Do not reuse another case's extension module
  // or replace Pi's normalizer/event stream with the unit-test doubles.
  vi.resetModules();
  const {
    normalizeContext,
    getCurrentTools,
    Type,
    createAssistantMessageEventStream,
  } = await import("@earendil-works/pi-ai");
  sandbox = mkdtempSync(join(tmpdir(), "registered-tools-"));
  const home = join(sandbox, "home");
  const workspace = join(sandbox, "workspace");
  const hostConfig = join(home, ".claude");
  mkdirSync(join(hostConfig, "skills", "planted"), { recursive: true });
  mkdirSync(workspace);
  writeFileSync(join(hostConfig, "CLAUDE.md"), MARKERS[0]);
  writeFileSync(join(hostConfig, "skills", "planted", "SKILL.md"), MARKERS[1]);
  writeFileSync(
    join(hostConfig, "settings.json"),
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: `echo ${MARKERS[2]}` }] },
        ],
      },
    }),
  );
  writeFileSync(join(workspace, "CLAUDE.md"), MARKERS[3]);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("CLAUDE_CONFIG_DIR", hostConfig);
  vi.stubEnv("TMPDIR", sandbox);
  vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_API_KEY_FALLBACK", "0");
  vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_SESSION_MODE", "replay");
  vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_TIMEOUT_MS", "5000");
  vi.stubEnv("FAKE_CLAUDE_EXTRA_GENERATIONS", "1");
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "FAKE_CLAUDE_NOT_LOGGED_IN",
    "FAKE_CLAUDE_FAIL_AFTER_REQUEST",
  ])
    vi.stubEnv(key, undefined);

  const tool = {
    name: TOOL_NAME,
    description: "Link the pull request associated with a path",
    parameters: Type.Object(
      {
        path: Type.String({
          description: "Repository-relative path",
          minLength: 1,
        }),
        pullRequest: Type.Optional(Type.Integer({ minimum: 1 })),
      },
      { additionalProperties: false },
    ),
    execute: vi.fn(async (_id: string, args: Record<string, unknown>) => ({
      content: [
        { type: "text" as const, text: `Linked ${args.path}: PR-8462` },
      ],
      details: { linked: true },
    })),
  };
  const tools = [tool];
  upstream = await startFakeUpstream(["t3_code_tool", "echo_tool_result"]);
  claude = installFakeClaude(upstream.url);
  const registerProvider =
    vi.fn<(name: string, config: ProviderConfig) => void>();
  const { default: extension } = await import("../index");
  extension({
    registerProvider,
    on: vi.fn(),
    getAllTools: () => tools,
  } as unknown as ExtensionAPI);
  expect(registerProvider).toHaveBeenCalledOnce();
  const [provider, config] = registerProvider.mock.calls[0];
  expect(provider).toBe("pi-claude-subscription");
  const registeredModel = config.models![0];
  if (!("reasoning" in registeredModel))
    throw new Error("Expected a chat model");
  const model: Model<Api> = {
    ...registeredModel,
    provider,
    api: config.api!,
    baseUrl: config.baseUrl!,
  };
  const context = normalizeContext({
    systemPrompt: "PI-STABLE-TOOLS-PROMPT",
    messages: [
      { role: "user", content: "Link the pull request", timestamp: 1 },
    ],
    tools,
  });
  expect("tools" in context).toBe(false);
  expect(getCurrentTools(context.messages)).toEqual(tools);

  async function request(ctx: typeof context, turn: number) {
    const recordFile = join(sandbox!, `record-${turn}.json`);
    vi.stubEnv("FAKE_CLAUDE_RECORD_FILE", recordFile);
    const options: SimpleStreamOptions & { cwd: string } = { cwd: workspace };
    const stream = config.streamSimple!(model, ctx, options);
    expect(stream).toBeInstanceOf(
      createAssistantMessageEventStream().constructor,
    );

    // The registered callback writes these synchronously. Read the actual files
    // before the asynchronous request can finish and delete them.
    const configs = readdirSync(sandbox!).filter((name) =>
      name.startsWith("pi-claude-mcp-config-"),
    );
    expect(configs).toHaveLength(1);
    const configPath = join(sandbox!, configs[0]);
    const mcpConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(Object.keys(mcpConfig.mcpServers)).toEqual(["custom-tools"]);
    const server = mcpConfig.mcpServers["custom-tools"];
    expect(server.command).toBe("node");
    expect(server.args[0]).toMatch(/mcp-schema-server\.cjs$/);
    const schemaPath = server.args[1];
    expect(JSON.parse(readFileSync(schemaPath, "utf-8"))).toEqual([
      {
        name: tool.name,
        description: tool.description,
        inputSchema: JSON.parse(JSON.stringify(tool.parameters)),
      },
    ]);

    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();
    expect(
      events.filter((event) => event.type === "done" || event.type === "error"),
    ).toEqual([expect.objectContaining({ type: "done", message: result })]);
    expect(result).toMatchObject({
      role: "assistant",
      provider,
      api: provider,
      model: model.id,
      usage: { input: 10, output: 5, totalTokens: 15 },
    });
    expect(result.timestamp).toBeGreaterThan(0);
    expect(result.usage.cost.total).toBeGreaterThan(0);
    expect(upstream!.requests).toHaveLength(turn);
    const body = upstream!.requests[turn - 1].body as {
      tools: { name: string }[];
      system: string;
      fake_cwd: string;
      fake_args: string[];
      messages: unknown[];
    };
    expect(body.tools).toEqual([{ name: `mcp__custom-tools__${TOOL_NAME}` }]);
    expect(body.system).not.toContain("You are Claude Code");
    for (const marker of MARKERS)
      expect(JSON.stringify(body)).not.toContain(marker);
    expect(body.fake_cwd).not.toBe(workspace);
    expect(body.fake_cwd).not.toBe(process.cwd());
    expect(body.fake_cwd.startsWith(realpathSync(sandbox!))).toBe(true);
    expect(body.fake_args[body.fake_args.indexOf("--mcp-config") + 1]).toBe(
      configPath,
    );
    expect(body.fake_args).toContain("--strict-mcp-config");

    const record = JSON.parse(readFileSync(recordFile, "utf-8"));
    expect(record.pids).toHaveLength(2);
    await vi.waitFor(() => {
      for (const pid of record.pids) expect(isAlive(pid)).toBe(false);
      for (const path of [body.fake_cwd, configPath, schemaPath])
        expect(existsSync(path)).toBe(false);
      expect(
        readdirSync(sandbox!).filter((name) => name.startsWith("pi-claude-")),
      ).toEqual([]);
    });
    await expect(fetch(record.baseUrl)).rejects.toThrow();
    return { result, events, body, configPath, schemaPath };
  }

  const first = await request(context, 1);
  expect(tool.execute).not.toHaveBeenCalled();
  expect(first.result.stopReason).toBe("toolUse");
  expect(first.result.content).toEqual([
    {
      type: "toolCall",
      id: "toolu_fake",
      name: TOOL_NAME,
      arguments: { path: "a.txt" },
    },
  ]);
  const call = first.result.content[0];
  if (call.type !== "toolCall") throw new Error("Expected a tool call");
  expect(first.events.filter((event) => event.type === "toolcall_end")).toEqual(
    [expect.objectContaining({ toolCall: call })],
  );
  const executed = await tool.execute(call.id, call.arguments);
  const toolResult: ToolResultMessage = {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    ...executed,
    isError: false,
    timestamp: 2,
  };
  const replay = normalizeContext({
    systemPrompt: "PI-STABLE-TOOLS-PROMPT",
    messages: [...context.messages, first.result, toolResult],
    tools,
  });
  expect("tools" in replay).toBe(false);
  expect(getCurrentTools(replay.messages)).toEqual(
    getCurrentTools(context.messages),
  );
  expect(replay.messages).toContainEqual(toolResult);
  const second = await request(replay, 2);
  expect(second.configPath).not.toBe(first.configPath);
  expect(second.schemaPath).not.toBe(first.schemaPath);
  expect(tool.execute).toHaveBeenCalledExactlyOnceWith(call.id, {
    path: "a.txt",
  });
  expect(second.result.stopReason).toBe("stop");
  const text = `Tool returned: ${executed.content[0].text}`;
  expect(second.result.content).toEqual([{ type: "text", text }]);
  expect(
    second.events
      .filter((event) => event.type === "text_delta")
      .map((event) => event.delta)
      .join(""),
  ).toBe(text);
  expect(JSON.stringify(first.body.messages)).not.toContain(
    executed.content[0].text,
  );
  expect(JSON.stringify(second.body.messages)).toContain(
    executed.content[0].text,
  );
});
