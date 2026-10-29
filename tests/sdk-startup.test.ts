import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { filterLatestPerFamily } from "../src/model-filter";
import {
  installFakeClaude,
  startFakeUpstream,
  NORMAL_TEXT,
  type FakeClaude,
  type FakeUpstream,
} from "./harness";

let root: string | undefined;
let claude: FakeClaude | undefined;
let upstream: FakeUpstream | undefined;
let session: AgentSession | undefined;

afterEach(async () => {
  try {
    await session?.abort();
    session?.dispose();
  } finally {
    claude?.restore();
    await upstream?.close();
    vi.unstubAllEnvs();
    if (root) rmSync(root, { recursive: true, force: true });
    session = undefined;
    claude = undefined;
    upstream = undefined;
    root = undefined;
  }
});

it("selects the registered subscription provider at SDK startup and completes a turn", async () => {
  root = mkdtempSync(join(tmpdir(), "pi-sdk-startup-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  const home = join(root, "home");
  const authDir = join(root, "auth");
  const catalogDir = join(root, "catalog");
  for (const dir of [cwd, agentDir, home, authDir, catalogDir]) {
    mkdirSync(dir, { recursive: true });
  }

  // Keep executable lookup, but inherit no credentials, Pi overrides or CLI modes.
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
  vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_TIMEOUT_MS", "5000");
  upstream = await startFakeUpstream(["normal"]);
  claude = installFakeClaude(upstream.url);

  // Import after environment isolation, including SDK module-level config.
  const {
    createAgentSession,
    createAgentSessionServices,
    ModelRuntime,
    SessionManager,
    SettingsManager,
  } = await import("@earendil-works/pi-coding-agent");
  const { anthropicProvider } =
    await import("@earendil-works/pi-ai/providers/anthropic");
  const { default: extension } = await import("../index");
  const provider = "pi-claude-subscription";
  const catalogModel = filterLatestPerFamily([
    ...anthropicProvider().getModels(),
  ]).find((model) => model.id.includes("sonnet"));
  expect(catalogModel).toBeDefined();
  if (!catalogModel) throw new Error("No Sonnet model in the pinned catalog");

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
      extensionFactories: [extension],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    },
  });
  expect(services.diagnostics).toEqual([]);
  const resourceLoader = services.resourceLoader;
  expect(resourceLoader.getExtensions().errors).toEqual([]);
  expect(resourceLoader.getExtensions().extensions).toHaveLength(1);
  const model = modelRuntime.getModel(provider, catalogModel.id);
  expect(model).toMatchObject({
    id: catalogModel.id,
    provider,
    api: provider,
    name: catalogModel.name,
    reasoning: catalogModel.reasoning,
    input: catalogModel.input,
    cost: catalogModel.cost,
    contextWindow: catalogModel.contextWindow,
    maxTokens: catalogModel.maxTokens,
  });
  expect(modelRuntime.getAvailableSnapshot()).toContainEqual(model);
  expect(upstream.requests).toHaveLength(0);

  const result = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    noTools: "all",
  });
  session = result.session;
  expect(result.modelFallbackMessage).toBeUndefined();
  // No model option was passed, so this checks settings-driven startup selection.
  expect(session.model).toEqual(model);
  if (!model) throw new Error("Subscription model was not registered");
  await session.bindExtensions({});
  await session.setModel(model);

  const deltas: string[] = [];
  const unsubscribe = session.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      deltas.push(event.assistantMessageEvent.delta);
    }
  });
  try {
    await session.prompt("Say hello through the SDK startup test");
  } finally {
    unsubscribe();
  }
  expect(deltas.join("")).toBe(NORMAL_TEXT);
  expect(session.getLastAssistantText()).toBe(NORMAL_TEXT);
  const replies = session.messages.filter(
    (message) => message.role === "assistant",
  );
  expect(replies).toHaveLength(1);
  expect(replies[0]).toMatchObject({
    role: "assistant",
    provider,
    api: provider,
    model: catalogModel.id,
    stopReason: "stop",
    content: [{ type: "text", text: NORMAL_TEXT }],
    usage: { input: 10, output: 5, totalTokens: 15 },
  });
  expect(replies[0].usage.cost.total).toBeGreaterThan(0);
  expect(upstream.requests).toHaveLength(1);
  expect(upstream.requests[0]).toMatchObject({
    method: "POST",
    path: "/v1/messages",
  });
  expect(JSON.stringify(upstream.requests[0].body)).toContain(
    "Say hello through the SDK startup test",
  );
}, 20_000);
