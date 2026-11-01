import type { ClaudeApiEvent, ClaudeUsage, TrackedContentBlock } from "./types";
import { calculateCost } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import {
  mapClaudeToolNameToPi,
  translateClaudeArgsToPi,
  isInternalClaudeTool,
} from "./tool-mapping.js";

/**
 * Extended tracking for tool_use content blocks during streaming.
 * Stores the Claude tool name for argument translation at block_stop.
 */
interface TrackedToolBlock {
  type: "tool_use";
  index: number;
  id: string;
  name: string; // Already mapped to pi name
  claudeName: string; // Original Claude name for arg translation
  arguments: Record<string, unknown>;
  partialJson: string;
}

/** Union of tracked block types for the blocks array. */
type TrackedBlock = TrackedContentBlock | TrackedToolBlock;

/**
 * The event bridge interface returned by createEventBridge.
 * handleEvent processes each Claude API streaming event and pushes
 * the appropriate pi events to the stream.
 * getOutput returns the accumulated AssistantMessage.
 */
export interface EventBridge {
  handleEvent(event: ClaudeApiEvent): void;
  getOutput(): AssistantMessage;
  /**
   * Why the streamed message is not a complete supported response, or
   * undefined once the top-level message, its blocks and stop reason all
   * completed.
   */
  getIncompleteReason(): string | undefined;
}

/**
 * Map Claude API stop reasons to pi's stop reason format. Unknown reasons
 * map to undefined: they are not evidence of a successful stop.
 */
function mapStopReason(
  reason: string,
): "stop" | "length" | "toolUse" | undefined {
  switch (reason) {
    case "tool_use":
      return "toolUse";
    case "max_tokens":
      return "length";
    case "end_turn":
    case "stop_sequence":
      return "stop";
    default:
      return undefined;
  }
}

/**
 * An empty assistant message for the model: no content, zero usage.
 */
export function createAssistantOutput(model: Model<any>): AssistantMessage {
  return {
    role: "assistant" as const,
    content: [] as (TextContent | ThinkingContent | ToolCall)[],
    api: "pi-claude-subscription",
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

/**
 * Create an event bridge that translates Claude API streaming events
 * into pi's AssistantMessageEventStream events.
 *
 * The bridge maintains internal state to track content blocks and
 * accumulate the final AssistantMessage. It handles:
 * - text content blocks (start/delta/stop -> text_start/text_delta/text_end)
 * - message lifecycle (message_start for usage, message_delta for stop reason, message_stop for done)
 * - unsupported block types (tool_use, thinking) with warnings
 */
export function createEventBridge(
  stream: AssistantMessageEventStream,
  model: Model<any>,
  piToolNames?: readonly string[],
): EventBridge {
  // Tracked content blocks indexed by Claude's content_block index
  const blocks: TrackedBlock[] = [];

  // The accumulated output message
  const output = createAssistantOutput(model);

  let started = false;

  // Completion evidence: the provider succeeds only on all of it
  let messageStopped = false;
  let rawStopReason: string | undefined;
  let stopReasonKnown = false;
  let openBlocks = 0;
  let unparseableTool: string | undefined;

  function handleEvent(event: ClaudeApiEvent): void {
    // Emit start event on first message — tells pi to begin incremental rendering
    if (!started) {
      stream.push({ type: "start", partial: output });
      started = true;
    }

    switch (event.type) {
      case "message_start":
        handleMessageStart(event);
        break;
      case "content_block_start":
        handleContentBlockStart(event);
        break;
      case "content_block_delta":
        handleContentBlockDelta(event);
        break;
      case "content_block_stop":
        handleContentBlockStop(event);
        break;
      case "message_delta":
        handleMessageDelta(event);
        break;
      case "message_stop":
        handleMessageStop();
        break;
      // Unknown event types are silently ignored
    }
  }

  /**
   * Record the reported 1-hour cache-write subset. Without a breakdown the
   * tier is unknown, so the previous value (or the 5-minute fallback) stands.
   */
  function applyCacheBreakdown(usage: ClaudeUsage): void {
    const longWrite = usage.cache_creation?.ephemeral_1h_input_tokens;
    if (longWrite != null) output.usage.cacheWrite1h = longWrite;
  }

  /**
   * Recompute total tokens and cost. The SDK's calculateCost prices
   * usage.cacheWrite1h at 2x input and the rest at the cacheWrite rate.
   */
  function recalculateUsage(): void {
    output.usage.totalTokens =
      output.usage.input +
      output.usage.output +
      output.usage.cacheRead +
      output.usage.cacheWrite;
    calculateCost(model, output.usage);
  }

  function handleMessageStart(event: ClaudeApiEvent): void {
    // A new top-level message must complete on its own
    messageStopped = false;
    rawStopReason = undefined;
    stopReasonKnown = false;

    const usage = event.message?.usage;
    if (usage) {
      output.usage.input = usage.input_tokens ?? 0;
      output.usage.output = usage.output_tokens ?? 0;
      output.usage.cacheRead = usage.cache_read_input_tokens ?? 0;
      output.usage.cacheWrite = usage.cache_creation_input_tokens ?? 0;
      applyCacheBreakdown(usage);
      recalculateUsage();
    }
  }

  function handleContentBlockStart(event: ClaudeApiEvent): void {
    const blockType = event.content_block?.type;

    if (blockType === "text") {
      const block: TrackedContentBlock = {
        type: "text",
        text: "",
        index: event.index ?? 0,
      };
      blocks.push(block);
      openBlocks++;
      output.content.push({ type: "text" as const, text: "" });

      stream.push({
        type: "text_start",
        contentIndex: output.content.length - 1,
        partial: output,
      });
    } else if (blockType === "thinking") {
      const block: TrackedContentBlock = {
        type: "thinking",
        text: "",
        index: event.index ?? 0,
      };
      blocks.push(block);
      openBlocks++;
      output.content.push({
        type: "thinking" as const,
        thinking: "",
        thinkingSignature: "",
      });

      stream.push({
        type: "thinking_start",
        contentIndex: output.content.length - 1,
        partial: output,
      });
    } else if (blockType === "tool_use") {
      const claudeName = event.content_block!.name!;

      // The CLI runs its internal tools itself; pi must not see them
      if (isInternalClaudeTool(claudeName)) return;

      const piName = mapClaudeToolNameToPi(claudeName, piToolNames);
      const id = event.content_block!.id!;

      const block: TrackedToolBlock = {
        type: "tool_use",
        index: event.index ?? 0,
        id,
        name: piName,
        claudeName,
        arguments: {},
        partialJson: "",
      };
      blocks.push(block);
      openBlocks++;
      output.content.push({
        type: "toolCall" as const,
        id,
        name: piName,
        arguments: {},
      } as ToolCall);

      stream.push({
        type: "toolcall_start",
        contentIndex: output.content.length - 1,
        partial: output,
      });
    }
    // Unknown block types silently ignored
  }

  function handleContentBlockDelta(event: ClaudeApiEvent): void {
    const deltaType = event.delta?.type;

    if (deltaType === "text_delta" && event.delta!.text != null) {
      const idx = blocks.findIndex((b) => b.index === event.index);
      if (idx === -1) return;

      const block = blocks[idx];
      if (block.type === "text") {
        block.text += event.delta!.text;
        const contentBlock = output.content[idx] as TextContent;
        contentBlock.text = block.text;

        stream.push({
          type: "text_delta",
          contentIndex: idx,
          delta: event.delta!.text,
          partial: output,
        });
      }
    } else if (
      deltaType === "thinking_delta" &&
      event.delta!.thinking != null
    ) {
      const idx = blocks.findIndex((b) => b.index === event.index);
      if (idx === -1) return;

      const block = blocks[idx];
      if (block.type === "thinking") {
        block.text += event.delta!.thinking;
        const contentBlock = output.content[idx] as ThinkingContent;
        contentBlock.thinking = block.text;

        stream.push({
          type: "thinking_delta",
          contentIndex: idx,
          delta: event.delta!.thinking,
          partial: output,
        });
      }
    } else if (
      deltaType === "input_json_delta" &&
      event.delta!.partial_json != null
    ) {
      const idx = blocks.findIndex((b) => b.index === event.index);
      if (idx === -1) return;

      const block = blocks[idx];
      if (block.type === "tool_use") {
        block.partialJson += event.delta!.partial_json;

        // Try to parse accumulated JSON -- on success update args, on failure keep previous
        try {
          block.arguments = JSON.parse(block.partialJson);
          (output.content[idx] as any).arguments = block.arguments;
        } catch {
          // Partial JSON not yet parseable -- keep previous arguments
        }

        stream.push({
          type: "toolcall_delta",
          contentIndex: idx,
          delta: event.delta!.partial_json,
          partial: output,
        });
      }
    } else if (
      deltaType === "signature_delta" &&
      event.delta!.signature != null
    ) {
      // Accumulate signature on the thinking block
      const idx = blocks.findIndex((b) => b.index === event.index);
      if (idx === -1) return;

      const block = blocks[idx];
      if (block.type === "thinking") {
        const contentBlock = output.content[idx] as ThinkingContent;
        contentBlock.thinkingSignature =
          (contentBlock.thinkingSignature || "") + event.delta!.signature;
      }
    }
  }

  function handleContentBlockStop(event: ClaudeApiEvent): void {
    const idx = blocks.findIndex((b) => b.index === event.index);
    if (idx === -1) return;

    const block = blocks[idx];
    // Clean up the tracking index from the block (no longer needed)
    delete (block as any).index;
    openBlocks--;

    if (block.type === "text") {
      stream.push({
        type: "text_end",
        contentIndex: idx,
        content: block.text,
        partial: output,
      });
    } else if (block.type === "thinking") {
      stream.push({
        type: "thinking_end",
        contentIndex: idx,
        content: block.text,
        partial: output,
      });
    } else if (block.type === "tool_use") {
      // Final JSON parse. A tool with no input streams no JSON at all.
      let finalArgs: Record<string, unknown>;
      try {
        const parsed = JSON.parse(block.partialJson || "{}");
        if (typeof parsed !== "object" || !parsed || Array.isArray(parsed))
          throw new Error("tool input is not an object");
        finalArgs = translateClaudeArgsToPi(block.claudeName, parsed);
      } catch {
        // Not a completed tool call: keep the last valid observed arguments
        // and leave the request to fail, without a toolcall_end
        unparseableTool ??= block.name;
        return;
      }

      // Update output.content with final arguments
      const contentBlock = output.content[idx] as ToolCall;
      contentBlock.arguments = finalArgs as ToolCall["arguments"];

      const toolCall = {
        type: "toolCall" as const,
        id: block.id,
        name: block.name,
        arguments: finalArgs,
      } as ToolCall;

      stream.push({
        type: "toolcall_end",
        contentIndex: idx,
        toolCall,
        partial: output,
      });
    }
  }

  function handleMessageDelta(event: ClaudeApiEvent): void {
    if (event.delta?.stop_reason) {
      rawStopReason = event.delta.stop_reason;
      const mapped = mapStopReason(rawStopReason);
      stopReasonKnown = mapped !== undefined;
      if (mapped) output.stopReason = mapped;
    }

    const usage = event.usage;
    if (usage) {
      if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
      if (usage.output_tokens != null)
        output.usage.output = usage.output_tokens;
      if (usage.cache_read_input_tokens != null)
        output.usage.cacheRead = usage.cache_read_input_tokens;
      if (usage.cache_creation_input_tokens != null)
        output.usage.cacheWrite = usage.cache_creation_input_tokens;
      applyCacheBreakdown(usage);
      recalculateUsage();
    }
  }

  function handleMessageStop(): void {
    // Only records completion: done event is pushed by the provider after
    // readline closes. Pushing done here (synchronously) prevents pi from
    // executing tools.
    messageStopped = true;
  }

  function getIncompleteReason(): string | undefined {
    if (!messageStopped)
      return "the response ended before the message completed";
    if (openBlocks > 0) return "a content block did not complete";
    if (unparseableTool)
      return `the ${unparseableTool} tool call had unparseable arguments`;
    if (rawStopReason === undefined)
      return "the message completed without a stop reason";
    if (!stopReasonKnown) return `unsupported stop reason "${rawStopReason}"`;
    return undefined;
  }

  return {
    handleEvent,
    getOutput: () => output,
    getIncompleteReason,
  };
}
