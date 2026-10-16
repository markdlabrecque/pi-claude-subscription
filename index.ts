/**
 * Pi extension entry point for pi-claude-subscription.
 *
 * Registers a custom provider that routes LLM calls through the Claude Code CLI
 * subprocess using stream-json NDJSON protocol.
 */

import { getModels } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { streamViaCli } from "./src/provider.js";
import {
  validateCliPresence,
  validateCliAuth,
  killAllProcesses,
} from "./src/process-manager.js";
import {
  isApiKeyFallbackEnabled,
  streamViaAnthropic,
} from "./src/api-key-fallback.js";
import { getToolDefs, writeMcpConfig } from "./src/mcp-config.js";

// Kill all active Claude subprocesses on process exit to prevent orphans
process.on("exit", killAllProcesses);

const PROVIDER_ID = "pi-claude-subscription";

let mcpConfigPath: string | undefined;
let mcpConfigResolved = false;

/**
 * Lazily generate MCP config on first request (not at load time).
 * pi.getAllTools() fails during extension loading; this defers it
 * until the pi runtime is fully initialized.
 *
 * Only locks (sets mcpConfigResolved) when getAllTools() returns a
 * real array — if it returns undefined/null (registry not ready),
 * we retry on the next request. Once the registry is ready we
 * commit to the result even if there are zero tools.
 *
 * Uses warn-don't-block: failure logs a warning but does not
 * prevent the provider from functioning (without tools).
 */
function ensureMcpConfig(pi: ExtensionAPI): string | undefined {
  if (mcpConfigResolved) return mcpConfigPath;
  try {
    const allTools = pi.getAllTools();

    // Registry not ready yet — don't lock, retry on next call
    if (!Array.isArray(allTools)) {
      return mcpConfigPath;
    }

    // Registry is ready — lock regardless of whether any tools exist
    mcpConfigResolved = true;

    const toolDefs = getToolDefs(pi);
    if (toolDefs.length > 0) {
      mcpConfigPath = writeMcpConfig(toolDefs);
      console.error(
        `[pi-claude-subscription] MCP config generated with ${toolDefs.length} tool(s)`,
      );
    }
  } catch (err) {
    console.warn(
      "[pi-claude-subscription] MCP config generation failed, tools unavailable:",
      err,
    );
  }
  return mcpConfigPath;
}

export default function (pi: ExtensionAPI) {
  try {
    // Startup validation
    validateCliPresence(); // throws if CLI not on PATH
    validateCliAuth(); // warns if not authenticated

    const models = getModels("anthropic").map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    }));

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
        const configPath = ensureMcpConfig(pi);
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
