import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverAndLoadExtensions,
  type AgentSession,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
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
let session: AgentSession | undefined;
let root: string | undefined;

afterEach(async () => {
  try {
    await session?.abort();
    session?.dispose();
  } finally {
    claude?.restore();
    await upstream?.close();
    vi.unstubAllEnvs();
    if (root) rmSync(root, { recursive: true, force: true });
    claude = upstream = session = root = undefined;
  }
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

// tintinweb/pi-manage-todo-list: independently authored, MIT, vendored
// byte-for-byte at one commit. The provenance record names the files and
// their checksums; nothing is fetched or built during tests.
const PINNED_COMMIT = "2eb22d3b0c9dd981398d928c8edcc4afce202fa1";
const fixtureDir = join(__dirname, "fixtures", "pi-manage-todo-list");
const SOURCES = [
  "src/index.ts",
  "src/tool.ts",
  "src/state-manager.ts",
  "src/types.ts",
  "src/ui/todo-widget.ts",
];

describe("third-party extension fixture provenance", () => {
  it("is the pinned upstream commit with licence, manifest and five sources unmodified", () => {
    const record = JSON.parse(
      readFileSync(join(fixtureDir, "PROVENANCE.json"), "utf-8"),
    );
    expect(record.repository).toBe(
      "https://github.com/tintinweb/pi-manage-todo-list",
    );
    expect(record.commit).toBe(PINNED_COMMIT);
    expect(record.version).toBe("0.4.0");
    expect(record.license).toBe("MIT");

    const files: { path: string; sha256: string; url: string }[] = record.files;
    expect(files.map((f) => f.path).sort()).toEqual(
      ["LICENSE", "package.json", ...SOURCES].sort(),
    );
    for (const file of files) {
      expect(file.url).toContain(`/${PINNED_COMMIT}/${file.path}`);
      const bytes = readFileSync(join(fixtureDir, file.path));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        file.sha256,
      );
    }
    const license = readFileSync(join(fixtureDir, "LICENSE"), "utf-8");
    expect(license).toContain("MIT License");
    expect(license).toContain("tintinweb");
    expect(license).toContain("WITHOUT WARRANTY OF ANY KIND");
    expect(
      JSON.parse(readFileSync(join(fixtureDir, "package.json"), "utf-8")).pi,
    ).toEqual({ extensions: ["./src/index.ts"] });
  });
});

describe("third-party extension through the installed Pi SDK", () => {
  it("runs the pinned manage_todo_list read through Pi's tool loop and the registered provider", async () => {
    root = mkdtempSync(join(tmpdir(), "pi-third-party-"));
    const cwd = join(root, "cwd");
    const agentDir = join(root, "agent");
    const home = join(root, "home");
    const authDir = join(root, "auth");
    const catalogDir = join(root, "catalog");
    for (const dir of [cwd, agentDir, home, authDir, catalogDir])
      mkdirSync(dir, { recursive: true });

    for (const key of Object.keys(process.env)) {
      if (key !== "PATH") vi.stubEnv(key, undefined);
    }
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
    vi.stubEnv("XDG_CACHE_HOME", join(home, ".cache"));
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("PI_OFFLINE", "1");
    vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_API_KEY_FALLBACK", "0");
    vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_SESSION_MODE", "replay");
    vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_TIMEOUT_MS", "5000");
    upstream = await startFakeUpstream(["todo_read_tool", "echo_tool_result"]);
    claude = installFakeClaude(upstream.url);

    const entry = join(fixtureDir, "src", "index.ts");
    expect(existsSync(entry)).toBe(true);

    const {
      createAgentSession,
      createAgentSessionServices,
      ModelRuntime,
      SessionManager,
      SettingsManager,
    } = await import("@earendil-works/pi-coding-agent");
    const { anthropicProvider } =
      await import("@earendil-works/pi-ai/providers/anthropic");
    const { filterLatestPerFamily } = await import("../src/model-filter");
    const { default: extension } = await import("../index");
    const provider = "pi-claude-subscription";
    const catalogModel = filterLatestPerFamily([
      ...anthropicProvider().getModels(),
    ]).find((m) => m.id.includes("sonnet"));
    if (!catalogModel) throw new Error("No Sonnet model in the pinned catalog");

    // A registered tool Pi never activates: it must stay unoffered/unexecuted.
    const deferredExecute = vi.fn();
    const deferred = (pi: ExtensionAPI) =>
      pi.registerTool({
        name: "deferred_probe",
        label: "Deferred probe",
        description: "Registered but inactive",
        parameters: {
          type: "object",
          properties: {},
        } as never,
        execute: deferredExecute,
      } as never);

    const settingsManager = SettingsManager.inMemory({
      defaultProvider: provider,
      defaultModel: catalogModel.id,
      defaultThinkingLevel: "off",
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: "off",
      enableInstallTelemetry: false,
    });
    const modelRuntime = await ModelRuntime.create({
      authPath: join(authDir, "auth.json"),
      modelsPath: join(catalogDir, "models.json"),
      modelsStorePath: join(catalogDir, "models-store.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      modelRuntime,
      resourceLoaderOptions: {
        extensionFactories: [extension, deferred],
        additionalExtensionPaths: [entry],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        appendSystemPrompt: ["PI-INSTRUCTION-MARKER-52"],
      },
    });
    const loaded = services.resourceLoader.getExtensions();
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions).toHaveLength(3);

    const model = modelRuntime.getModel(provider, catalogModel.id);
    if (!model) throw new Error("Subscription model was not registered");
    const result = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      resourceLoader: services.resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(cwd),
      noTools: "builtin",
      tools: ["manage_todo_list"],
    });
    session = result.session;
    await session.bindExtensions({});
    await session.setModel(model);
    expect(session.getAllTools().map((t) => t.name)).toContain(
      "deferred_probe",
    );
    expect(session.getActiveToolNames()).toEqual(["manage_todo_list"]);

    await session.prompt("Read my todo list");

    // Two provider calls, one upstream Messages request each.
    expect(upstream.requests).toHaveLength(2);
    expect(upstream.requests.map((r) => r.path)).toEqual([
      "/v1/messages",
      "/v1/messages",
    ]);
    const [first, second] = upstream.requests.map((r) => r.body as any);
    for (const body of [first, second]) {
      expect(body.system).toContain("PI-INSTRUCTION-MARKER-52");
      expect(body.tools).toEqual([
        { name: "mcp__custom-tools__manage_todo_list" },
      ]);
    }

    const assistants = session.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(2);
    const call = (assistants[0].content as any[])[0];
    expect(assistants[0].stopReason).toBe("toolUse");
    expect(call).toMatchObject({
      type: "toolCall",
      id: "toolu_todo_read",
      name: "manage_todo_list",
      arguments: { operation: "read" },
    });
    const text = "No todos. Use write operation to create a todo list.";
    const toolResults = session.messages.filter((m) => m.role === "toolResult");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({
      toolCallId: "toolu_todo_read",
      toolName: "manage_todo_list",
      isError: false,
      content: [{ type: "text", text }],
      details: { operation: "read", todos: [] },
    });
    // The actual tool result reaches the next request, before the final text.
    expect(JSON.stringify(first.messages)).not.toContain(text);
    expect(JSON.stringify(second.messages)).toContain(text);
    expect(assistants[1].stopReason).toBe("stop");
    expect(assistants[1].content).toEqual([
      { type: "text", text: `Tool returned: ${text}` },
    ]);
    for (const reply of assistants) {
      expect(reply.usage).toMatchObject({
        input: 10,
        output: 5,
        totalTokens: 15,
      });
    }
    expect(deferredExecute).not.toHaveBeenCalled();
  }, 30_000);
});

describe("provider environment and observation (#50/#51)", () => {
  it("routes by scoped environment and honors an in-place payload edit at the upstream", async () => {
    upstream = await startFakeUpstream(["normal"]);
    claude = installFakeClaude("http://127.0.0.1:1");

    const stream = streamViaCli(
      model,
      { messages: [{ role: "user", content: "Hi", timestamp: 1 }] },
      {
        env: { ANTHROPIC_BASE_URL: upstream.url },
        onPayload: async (payload: any) => {
          payload.temperature = 0.25;
        },
      } as any,
    );
    for await (const _ of stream);

    expect((await stream.result()).stopReason).toBe("stop");
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0].body).toMatchObject({ temperature: 0.25 });
  });
});
