/**
 * Pi extension entry point for pi-claude-subscription.
 *
 * Registers a custom provider that routes LLM calls through the Claude Code CLI
 * subprocess using stream-json NDJSON protocol.
 */

import {
  createAssistantMessageEventStream,
  getCurrentTools,
  type AssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { streamViaCli } from "./src/provider.js";
import { createEventBridge } from "./src/event-bridge.js";
import { filterLatestPerFamily } from "./src/model-filter.js";
import { getCliThinkingLevelMap } from "./src/thinking-config.js";
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
import { toMcpToolDefs, writeMcpConfig } from "./src/mcp-config.js";

// Kill all active Claude subprocesses on process exit to prevent orphans
process.on("exit", killAllProcesses);
// Signal deaths skip 'exit', so the CLI groups are also reaped on terminal signals
installSignalCleanup();

const PROVIDER_ID = "pi-claude-subscription";

/**
 * Write a fresh MCP config for one request, offering exactly the tools Pi
 * offers in this request's transcript after its loadout preparation. Nothing
 * is cached across requests, so additions, removals and changed definitions
 * are followed. The caller's provider removes the file when the request ends.
 *
 * Returns undefined when Pi offers no tools. Throws when a nonempty inventory
 * cannot be prepared.
 */
function writeRequestMcpConfig(messages: readonly { role: string }[]) {
  const toolDefs = toMcpToolDefs(getCurrentTools(messages));
  return toolDefs.length ? writeMcpConfig(toolDefs) : undefined;
}

/** End a request as an error before the CLI is started. */
function failedRequest(
  model: Model<any>,
  errorMessage: string,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output = createEventBridge(stream, model).getOutput();
  stream.push({
    type: "error",
    reason: "error",
    error: { ...output, stopReason: "error", errorMessage },
  });
  stream.end();
  return stream;
}

export default function (pi: ExtensionAPI) {
  try {
    // Startup validation
    validateCliPresence(); // throws if CLI not on PATH
    validateCliAuth(); // warns if not authenticated

    const models = filterLatestPerFamily(
      anthropicProvider()
        .getModels()
        .map((model) => ({
          id: model.id,
          name: model.name,
          reasoning: model.reasoning,
          input: model.input,
          cost: model.cost,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          inputLimits: model.inputLimits,
          thinkingLevelMap: getCliThinkingLevelMap(model),
        })),
    );

    pi.registerProvider(PROVIDER_ID, {
      baseUrl: "pi-claude-subscription",
      apiKey: "unused",
      api: "pi-claude-subscription",
      models,
      streamSimple: (model, context, options) => {
        if (isApiKeyFallbackEnabled()) {
          return streamViaAnthropic(model, context, options);
        }
        let configPath: string | undefined;
        try {
          configPath = writeRequestMcpConfig(context.messages);
        } catch (err) {
          // Never start a generation without the tools Pi offered
          const reason = err instanceof Error ? err.message : String(err);
          return failedRequest(
            model,
            `Could not prepare the tool list for Claude: ${reason}`,
          );
        }
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
