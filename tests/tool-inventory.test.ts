import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  normalizeContext,
  Type,
  type Api,
  type AssistantMessageEvent,
  type Model,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import {
  installFakeClaude,
  startFakeUpstream,
  type FakeClaude,
} from "./harness";
import { streamViaCli } from "../src/provider.js";
import { removeMcpConfig } from "../src/mcp-config.js";

// Only the CLI seam is replaced: index.ts's registered callback decides which
// tools are written to the MCP config handed to it.
vi.mock("../src/provider.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/provider.js")>()),
  streamViaCli: vi.fn(),
}));

const cliMock = vi.mocked(streamViaCli);
let claude: FakeClaude | undefined;
let upstream: Awaited<ReturnType<typeof startFakeUpstream>> | undefined;
let sandbox: string | undefined;
const configPaths: string[] = [];

type Def = { name: string; description: string; parameters: unknown };

function def(name: string, description: string, field = "path"): Def {
  return {
    name,
    description,
    parameters: Type.Object({ [field]: Type.String() }),
  };
}

beforeEach(async () => {
  sandbox = mkdtempSync(join(tmpdir(), "tool-inventory-"));
  vi.stubEnv("TMPDIR", sandbox);
  vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_API_KEY_FALLBACK", "0");
  upstream = await startFakeUpstream();
  claude = installFakeClaude(upstream.url);
  cliMock.mockImplementation((() => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => stream.end());
    return stream;
  }) as unknown as typeof streamViaCli);
});

afterEach(async () => {
  for (const path of configPaths.splice(0)) removeMcpConfig(path);
  cliMock.mockReset();
  claude?.restore();
  await upstream?.close();
  vi.unstubAllEnvs();
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

/** Register a fresh extension instance; getAllTools is Pi's registry, which is NOT the offered set. */
async function register(registered: Def[]) {
  const registerProvider =
    vi.fn<(name: string, config: ProviderConfig) => void>();
  const handlers: Record<string, () => unknown> = {};
  const setActiveTools = vi.fn();
  const { default: extension } = await import("../index");
  extension({
    registerProvider,
    on: (event: string, handler: () => unknown) => {
      handlers[event] = handler;
    },
    getAllTools: () => registered,
    setActiveTools,
  } as unknown as ExtensionAPI);
  const [id, config] = registerProvider.mock.calls[0];
  const model = {
    ...(config.models![0] as object),
    provider: id,
    api: config.api!,
    baseUrl: config.baseUrl!,
  } as Model<Api>;
  return { config, model, handlers, setActiveTools };
}

/** Issue one request offering `offered`, return the inventory Claude is given. */
function offeredTo(
  reg: Awaited<ReturnType<typeof register>>,
  offered: Def[] | undefined,
) {
  const context = normalizeContext({
    messages: [{ role: "user", content: "hi", timestamp: 1 }],
    ...(offered ? { tools: offered } : {}),
  } as never);
  const callsBefore = cliMock.mock.calls.length;
  reg.config.streamSimple!(reg.model, context, {});
  expect(cliMock.mock.calls).toHaveLength(callsBefore + 1);
  const options = cliMock.mock.calls[callsBefore][2] as {
    mcpConfigPath?: string;
  };
  if (!options.mcpConfigPath) return undefined;
  configPaths.push(options.mcpConfigPath);
  const config = JSON.parse(readFileSync(options.mcpConfigPath, "utf-8"));
  const schemaPath = config.mcpServers["custom-tools"].args[1];
  return {
    configPath: options.mcpConfigPath,
    schemaPath,
    defs: JSON.parse(readFileSync(schemaPath, "utf-8")) as {
      name: string;
      description: string;
      inputSchema: unknown;
    }[],
  };
}

const json = (value: unknown) => JSON.parse(JSON.stringify(value));

it("offers no tools until a later request offers one", async () => {
  const a = def("tool_a", "A");
  const reg = await register([a]);
  expect(offeredTo(reg, undefined)).toBeUndefined();
  const second = offeredTo(reg, [a]);
  expect(second?.defs.map((d) => d.name)).toEqual(["tool_a"]);
});

it("follows tools removed and added between requests", async () => {
  const a = def("tool_a", "A");
  const b = def("tool_b", "B");
  const reg = await register([a, b]);
  expect(offeredTo(reg, [a])?.defs.map((d) => d.name)).toEqual(["tool_a"]);
  expect(offeredTo(reg, [b])?.defs.map((d) => d.name)).toEqual(["tool_b"]);
});

it("sends a changed description and schema for an unchanged name", async () => {
  const v1 = def("tool_a", "first", "path");
  const v2 = def("tool_a", "second", "query");
  const reg = await register([v1]);
  expect(offeredTo(reg, [v1])?.defs).toEqual([
    { name: "tool_a", description: "first", inputSchema: json(v1.parameters) },
  ]);
  expect(offeredTo(reg, [v2])?.defs).toEqual([
    { name: "tool_a", description: "second", inputSchema: json(v2.parameters) },
  ]);
});

it("does not offer or activate registered tools Pi left inactive", async () => {
  const active = def("tool_active", "on");
  const inactive = def("tool_inactive", "deferred");
  const reg = await register([active, inactive]);
  await reg.handlers.session_start?.();
  expect(reg.setActiveTools).not.toHaveBeenCalled();
  expect(offeredTo(reg, [active])?.defs.map((d) => d.name)).toEqual([
    "tool_active",
  ]);
  expect(offeredTo(reg, [active, inactive])?.defs.map((d) => d.name)).toEqual([
    "tool_active",
    "tool_inactive",
  ]);
});

it("keeps separate extension instances from sharing stale definitions", async () => {
  const one = def("tool_one", "one");
  const two = def("tool_two", "two");
  const first = await register([one]);
  expect(offeredTo(first, [one])?.defs.map((d) => d.name)).toEqual([
    "tool_one",
  ]);
  const second = await register([two]);
  expect(offeredTo(second, [two])?.defs.map((d) => d.name)).toEqual([
    "tool_two",
  ]);
  expect(offeredTo(first, [one])?.defs.map((d) => d.name)).toEqual([
    "tool_one",
  ]);
});

it("passes MCP-style custom tool names through exactly as Pi offered them", async () => {
  const custom = def("mcp__t3-code__link_pull_request", "link");
  const reg = await register([custom]);
  expect(offeredTo(reg, [custom])?.defs.map((d) => d.name)).toEqual([
    "mcp__t3-code__link_pull_request",
  ]);
});

it("terminates with an error, without starting a tool-less generation, when the config cannot be written", async () => {
  const a = def("tool_a", "A");
  const reg = await register([a]);
  vi.stubEnv("TMPDIR", join(sandbox!, "does-not-exist"));
  const context = normalizeContext({
    messages: [{ role: "user", content: "hi", timestamp: 1 }],
    tools: [a],
  } as never);
  const stream = reg.config.streamSimple!(reg.model, context, {});
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  const result = await stream.result();
  expect(cliMock).not.toHaveBeenCalled();
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toMatch(/tool/i);
  expect(events.at(-1)?.type).toBe("error");
});

it("writes a fresh config and schema file per request and removes both on cleanup", async () => {
  const a = def("tool_a", "A");
  const reg = await register([a]);
  const first = offeredTo(reg, [a])!;
  const second = offeredTo(reg, [a])!;
  expect(second.configPath).not.toBe(first.configPath);
  expect(second.schemaPath).not.toBe(first.schemaPath);
  removeMcpConfig(first.configPath);
  expect(existsSync(first.configPath)).toBe(false);
  expect(existsSync(first.schemaPath)).toBe(false);
  expect(existsSync(second.configPath)).toBe(true);
  expect(existsSync(second.schemaPath)).toBe(true);
});
