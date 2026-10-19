/**
 * Pi extension entry point for pi-claude-subscription.
 *
 * Registers a custom provider that routes LLM calls through the Claude Code CLI
 * subprocess using stream-json NDJSON protocol.
 */

import { getModels } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { streamViaCli } from "./src/provider.js";
import { filterLatestPerFamily } from "./src/model-filter.js";
import {
  validateCliPresence,
  validateCliAuth,
  killAllProcesses,
  installSignalCleanup,
} from "./src/process-manager.js";
import {
  isApiKeyFallbackEnabled,
  streamViaAnthropic,
} from "./src/api-key-fallback.js";
import {
  getToolDefs,
  writeMcpConfig,
  type McpToolDef,
} from "./src/mcp-config.js";

// Kill all active Claude subprocesses on process exit to prevent orphans
process.on("exit", killAllProcesses);
// Signal deaths skip 'exit', so the CLI groups are also reaped on terminal signals
installSignalCleanup();

const PROVIDER_ID = "pi-claude-subscription";

let toolDefs: McpToolDef[] | undefined;
let toolDefsResolved = false;

/**
 * Lazily discover tools and write a fresh MCP config for one request (not at
 * load time). pi.getAllTools() fails during extension loading; this defers it
 * until the pi runtime is fully initialized. The caller's provider removes the
 * file when the request ends.
 *
 * Only locks the tool list (sets toolDefsResolved) when getAllTools() returns a
 * real array — if it returns undefined/null (registry not ready),
 * we retry on the next request. Once the registry is ready we
 * commit to the result even if there are zero tools.
 *
 * Uses warn-don't-block: failure logs a warning but does not
 * prevent the provider from functioning (without tools).
 */
function writeRequestMcpConfig(pi: ExtensionAPI): string | undefined {
  try {
    if (!toolDefsResolved) {
      const allTools = pi.getAllTools();

      // Registry not ready yet — don't lock, retry on next call
      if (!Array.isArray(allTools)) return undefined;

      // Registry is ready — lock regardless of whether any tools exist
      toolDefsResolved = true;
      toolDefs = getToolDefs(pi);
      if (toolDefs.length > 0) {
        console.error(
          `[pi-claude-subscription] MCP config will offer ${toolDefs.length} tool(s)`,
        );
      }
    }
    return toolDefs?.length ? writeMcpConfig(toolDefs) : undefined;
  } catch (err) {
    console.warn(
      "[pi-claude-subscription] MCP config generation failed, tools unavailable:",
      err,
    );
    return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  try {
    // Startup validation
    validateCliPresence(); // throws if CLI not on PATH
    validateCliAuth(); // warns if not authenticated

    const models = filterLatestPerFamily(
      getModels("anthropic").map((model) => ({
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        input: model.input,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      })),
    );

    // The pi-ai catalog may predate Fable; the CLI accepts it by alias.
    if (!models.some((m) => m.id.includes("fable"))) {
      models.push({
        id: "fable",
        name: "Claude Fable",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 64000,
      });
    }

    // Ensure all registered tools are active so pi can execute them.
    // Some tools (find, grep, ls) are registered but not activated by default.
    pi.on("session_start", async () => {
      const allTools = pi.getAllTools();
      if (Array.isArray(allTools)) {
        pi.setActiveTools(allTools.map((t: any) => t.name));
      }
    });

    pi.registerProvider(PROVIDER_ID, {
      baseUrl: "pi-claude-subscription",
      apiKey: "unused",
      api: "pi-claude-subscription",
      models,
      streamSimple: (model, context, options) => {
        if (isApiKeyFallbackEnabled()) {
          return streamViaAnthropic(model, context, options);
        }
        const configPath = writeRequestMcpConfig(pi);
        return streamViaCli(model, context, {
          ...options,
          mcpConfigPath: configPath,
        });
      },
    });
  } catch (err) {
    console.error(`[pi-claude-subscription] Failed to register provider:`, err);
  }
}
