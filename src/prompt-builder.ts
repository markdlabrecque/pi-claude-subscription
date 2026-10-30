/**
 * Prompt builder for flattening pi conversation history into a labeled text prompt.
 *
 * Follows the reference project's buildPromptBlocks() pattern:
 * - USER: / ASSISTANT: / TOOL RESULT: labels
 * - Content blocks serialized by type
 * - Images and documents in the final user message are passed through to Anthropic API format (HIST-02)
 * - Images in non-final messages get placeholder text with console.warn
 */

import {
  getCurrentSystemMessage,
  getCurrentSystemPrompt,
  normalizeContext,
  type Context,
} from "@earendil-works/pi-ai";
import {
  mapPiToolNameToClaude,
  translatePiArgsToClaude,
  isCustomToolName,
  CUSTOM_TOOLS_MCP_PREFIX,
} from "./tool-mapping.js";

/**
 * Anthropic API content block types for passthrough (images and documents).
 * Used when the final user message contains images that need to be
 * translated from pi-ai format to Anthropic format.
 */
type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    }
  | { type: "document"; source: unknown };

// We use `any` for Context to avoid requiring @earendil-works/pi-ai at dev time.
// At runtime, pi provides the real Context type.

/**
 * Flattens a pi conversation context's messages array into a labeled text prompt
 * suitable for sending to the Claude CLI subprocess.
 *
 * Each message is labeled with its role:
 * - USER: for user messages
 * - ASSISTANT: for assistant messages
 * - TOOL RESULT (historical {toolName}): for tool result messages
 */
/** Module-level counter for placeholder images, reset per buildPrompt call. */
let placeholderImageCount = 0;

/**
 * Translate a pi-ai image block to Anthropic API format.
 * Returns null if the block is missing required data/mimeType fields.
 *
 * pi-ai format:  { type: "image", data: string (base64), mimeType: string }
 * Anthropic format: { type: "image", source: { type: "base64", media_type: string, data: string } }
 */
function translateImageBlock(piBlock: any): AnthropicContentBlock | null {
  if (piBlock.data && piBlock.mimeType) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: piBlock.mimeType,
        data: piBlock.data,
      },
    };
  }
  return null; // Invalid image block, will fall back to placeholder
}

/**
 * Build content blocks for the final user message, translating images
 * from pi-ai format to Anthropic API format.
 *
 * @returns Array of AnthropicContentBlock with text and translated images
 */
function buildFinalUserContent(
  content: string | any[],
): AnthropicContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    return [{ type: "text", text: "" }];
  }

  const blocks: AnthropicContentBlock[] = [];
  for (const block of content) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text ?? "" });
    } else if (block.type === "image") {
      const translated = translateImageBlock(block);
      if (translated) {
        blocks.push(translated);
      } else {
        // Invalid image block: fall back to placeholder text
        blocks.push({
          type: "text",
          text: "[An image was shared here but could not be included]",
        });
        placeholderImageCount++;
      }
    } else if (block.type === "document" && block.source) {
      blocks.push({ type: "document", source: block.source });
    }
    // Unknown block types silently skipped
  }
  return blocks;
}

/**
 * Check if a message content array contains blocks sent to Claude as-is
 * (images and documents).
 */
function contentHasPassthrough(content: string | any[]): boolean {
  if (typeof content === "string" || !Array.isArray(content)) return false;
  return content.some(
    (block) => block.type === "image" || block.type === "document",
  );
}

/**
 * Check if the conversation ends with a custom tool result.
 * If so, build a simplified prompt that presents the result directly
 * instead of replaying the full conversation history with tool labels.
 */
function buildCustomToolResultPrompt(messages: any[]): string | null {
  if (messages.length < 3) return null;

  const last = messages[messages.length - 1];
  if (last.role !== "toolResult") return null;
  if (!last.toolName || !isCustomToolName(last.toolName)) return null;

  // Find the original user message (scan backwards past assistant + toolResult)
  let userMessage: string | null = null;
  for (let i = messages.length - 3; i >= 0; i--) {
    if (messages[i].role === "user") {
      userMessage = userContentToText(messages[i].content);
      break;
    }
  }
  if (!userMessage) return null;

  const toolResult = toolResultContentToText(last.content);
  return `${userMessage}\n\n[The ${last.toolName} tool was called and returned the following result]\n${toolResult}\n\nRespond to the user using the tool result above.`;
}

/**
 * Build a prompt for a resumed session.
 *
 * When resuming via --resume, the CLI already has the full conversation history.
 * We only need to send the new content since the last turn: the last assistant
 * response's tool results (if any) followed by the latest user message.
 *
 * For tool_use flows: pi sends [user, assistant(toolCall), toolResult, ...]
 * We need to include tool results so the resumed session sees them, plus the
 * final user message.
 *
 * Falls back to full prompt if the message structure is unexpected.
 */
export function buildResumePrompt(context: {
  messages: any[];
}): string | AnthropicContentBlock[] {
  const messages = context.messages;
  if (messages.length === 0) return "";

  // Find the last user message
  const finalUserIndex = findFinalUserMessageIndex(messages);
  if (finalUserIndex < 0) return "";

  // Collect new messages: everything from the last assistant turn onwards
  // (tool results from the last assistant + the new user message)
  const newMessages: any[] = [];

  // Walk backwards from finalUserIndex to find where new content starts.
  // Include trailing toolResult messages that follow the last assistant turn.
  let startIdx = finalUserIndex;
  for (let i = finalUserIndex - 1; i >= 0; i--) {
    if (messages[i].role === "toolResult") {
      startIdx = i;
    } else {
      break;
    }
  }

  for (let i = startIdx; i < messages.length; i++) {
    newMessages.push(messages[i]);
  }

  // If there are only tool results + one user message, build a combined prompt
  const parts: string[] = [];
  for (const msg of newMessages) {
    if (msg.role === "toolResult") {
      if (msg.toolName && isCustomToolName(msg.toolName)) {
        parts.push(`TOOL RESULT (${msg.toolName}):`);
      } else {
        const claudeToolName = msg.toolName
          ? mapPiToolNameToClaude(msg.toolName)
          : "unknown";
        parts.push(`TOOL RESULT (historical ${claudeToolName}):`);
      }
      parts.push(toolResultContentToText(msg.content));
    } else if (msg.role === "user") {
      // Check for images in the final user message
      if (contentHasPassthrough(msg.content)) {
        const textSoFar = parts.join("\n");
        const userContent = buildFinalUserContent(msg.content);
        const result: AnthropicContentBlock[] = [];
        if (textSoFar) {
          result.push({ type: "text", text: textSoFar });
        }
        result.push(...userContent);
        return result;
      }
      parts.push(userContentToText(msg.content));
    }
  }

  return parts.join("\n") || "";
}

/**
 * Build the prompt for replay mode: one text block per history message, oldest
 * first, each wrapped in a <turn> tag. Tool calls and results ride along as
 * text inside their turns. Images in the final user message pass through as
 * image blocks after its turn, and documents in any user turn follow that
 * turn. Earlier images become a text placeholder.
 *
 * Block bytes depend only on their own message, so earlier blocks stay stable
 * between turns and hit the prompt cache.
 */
export function buildReplayPrompt(context: {
  messages: any[];
}): AnthropicContentBlock[] {
  placeholderImageCount = 0;
  const finalUserIndex = findFinalUserMessageIndex(context.messages);
  const blocks: AnthropicContentBlock[] = [];

  context.messages.forEach((message, i) => {
    let tag: string;
    let text: string;
    if (message.role === "user") {
      tag = `<turn role="user">`;
      text = userContentToText(
        i === finalUserIndex && contentHasPassthrough(message.content)
          ? (message.content as any[]).filter(
              (b) => b.type !== "image" && b.type !== "document",
            )
          : withoutDocuments(message.content),
      );
    } else if (message.role === "assistant") {
      tag = `<turn role="assistant">`;
      text = contentToText(message.content);
    } else if (message.role === "toolResult") {
      tag = `<turn role="tool"${message.toolName ? ` name="${message.toolName}"` : ""}>`;
      text = toolResultContentToText(message.content);
    } else {
      return;
    }
    blocks.push({ type: "text", text: `${tag}\n${text}\n</turn>` });
    if (message.role === "user")
      blocks.push(...documentBlocks(message.content));

    if (i === finalUserIndex && contentHasPassthrough(message.content)) {
      blocks.push(
        ...buildFinalUserContent(message.content).filter(
          (b) => b.type === "image",
        ),
      );
    }
  });

  if (placeholderImageCount > 0) {
    console.warn(
      `[pi-claude-subscription] ${placeholderImageCount} image(s) in conversation history could not be included in the prompt`,
    );
  }
  return blocks;
}

export function buildPrompt(context: {
  messages: any[];
}): string | AnthropicContentBlock[] {
  // Reset placeholder counter for each call
  placeholderImageCount = 0;

  // Special case: when conversation ends with a custom tool result,
  // present it directly instead of complex history replay
  const customToolPrompt = buildCustomToolResultPrompt(context.messages);
  if (customToolPrompt) {
    // customToolPrompt calls userContentToText which may increment placeholderImageCount
    if (placeholderImageCount > 0) {
      console.warn(
        `[pi-claude-subscription] ${placeholderImageCount} image(s) in conversation history could not be included in the prompt`,
      );
    }
    return customToolPrompt;
  }

  // Determine if any message has images worth passing through
  const finalUserIndex = findFinalUserMessageIndex(context.messages);
  const finalUserHasImages =
    finalUserIndex >= 0 &&
    contentHasPassthrough(context.messages[finalUserIndex].content);
  const anyToolResultHasImages = context.messages.some(
    (m: any) => m.role === "toolResult" && toolResultHasImages(m.content),
  );

  const anyUserHasDocument = context.messages.some(
    (m: any) =>
      m.role === "user" &&
      Array.isArray(m.content) &&
      m.content.some((b: any) => b.type === "document" && b.source),
  );

  if (finalUserHasImages || anyToolResultHasImages || anyUserHasDocument) {
    // Build history as text (all messages except the final user message)
    const historyParts: string[] = [];
    const historyDocuments: AnthropicContentBlock[] = [];
    const toolResultImageBlocks: AnthropicContentBlock[] = [];
    for (let i = 0; i < context.messages.length; i++) {
      if (i === finalUserIndex) continue; // Skip final user message -- handled separately
      const message = context.messages[i];
      if (message.role === "user") {
        historyDocuments.push(...documentBlocks(message.content));
        historyParts.push("USER:");
        historyParts.push(userContentToText(withoutDocuments(message.content)));
      } else if (message.role === "assistant") {
        historyParts.push("ASSISTANT:");
        historyParts.push(contentToText(message.content));
      } else if (message.role === "toolResult") {
        if (message.toolName && isCustomToolName(message.toolName)) {
          historyParts.push(`TOOL RESULT (${message.toolName}):`);
        } else {
          const claudeToolName = message.toolName
            ? mapPiToolNameToClaude(message.toolName)
            : "unknown";
          historyParts.push(`TOOL RESULT (historical ${claudeToolName}):`);
        }
        // Extract text portion of tool result
        historyParts.push(toolResultContentToText(message.content));
        // Collect image blocks from tool results for passthrough
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.type === "image") {
              const translated = translateImageBlock(block);
              if (translated) {
                toolResultImageBlocks.push(translated);
                // Undo the placeholder count from toolResultContentToText since we're passing through
                placeholderImageCount--;
              }
            }
          }
        }
      }
    }

    // Build final user message content blocks
    const finalUserContent =
      finalUserIndex >= 0
        ? buildFinalUserContent(context.messages[finalUserIndex].content)
        : [];

    // Combine: history text + tool result images + final user content blocks
    const result: AnthropicContentBlock[] = [...historyDocuments];
    const historyText = historyParts.join("\n");
    if (historyText) {
      result.push({ type: "text", text: historyText });
    }
    // Insert tool result images after history text (Claude sees them in context)
    result.push(...toolResultImageBlocks);
    result.push(...finalUserContent);

    if (placeholderImageCount > 0) {
      console.warn(
        `[pi-claude-subscription] ${placeholderImageCount} image(s) in conversation history could not be included in the prompt`,
      );
    }

    return result;
  }

  // No images in final user message: standard text-only path
  const parts: string[] = [];

  for (const message of context.messages) {
    if (message.role === "user") {
      parts.push("USER:");
      parts.push(userContentToText(message.content));
    } else if (message.role === "assistant") {
      parts.push("ASSISTANT:");
      parts.push(contentToText(message.content));
    } else if (message.role === "toolResult") {
      if (message.toolName && isCustomToolName(message.toolName)) {
        // Custom tools: don't reference MCP tool name. Present result plainly.
        parts.push(`TOOL RESULT (${message.toolName}):`);
      } else {
        const claudeToolName = message.toolName
          ? mapPiToolNameToClaude(message.toolName)
          : "unknown";
        parts.push(`TOOL RESULT (historical ${claudeToolName}):`);
      }
      parts.push(toolResultContentToText(message.content));
    }
  }

  if (placeholderImageCount > 0) {
    console.warn(
      `[pi-claude-subscription] ${placeholderImageCount} image(s) in conversation history could not be included in the prompt`,
    );
  }

  return parts.join("\n") || "";
}

/**
 * Describe the first block in the final user message that cannot reach Claude
 * (anything but text, image, or a document with a source), or null if there is none. Rejecting it up
 * front keeps attachments from being dropped silently.
 */
export function findUnsupportedAttachment(messages: any[]): string | null {
  const index = findFinalUserMessageIndex(messages);
  const content = index >= 0 ? messages[index].content : undefined;
  if (!Array.isArray(content)) return null;
  const block = content.find(
    (b) =>
      b.type !== "text" &&
      b.type !== "image" &&
      !(b.type === "document" && b.source),
  );
  return block
    ? `"${block.type}" attachments are not supported by pi-claude-subscription; only text, images, and documents can be sent.`
    : null;
}

/** Identical failed tool calls in a row before the provider stops the turn. */
export const MAX_REPEATED_TOOL_FAILURES = 3;

/**
 * Describe a run of MAX_REPEATED_TOOL_FAILURES or more trailing tool results
 * that failed with the same tool, arguments, and error, or null if there is
 * none. Each retry re-sends the whole context, so a stuck model is costly.
 */
export function findRepeatedToolFailure(messages: any[]): string | null {
  const callArgs = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content))
      continue;
    for (const block of message.content) {
      if (block.type === "toolCall")
        callArgs.set(block.id, JSON.stringify(block.arguments ?? {}));
    }
  }

  let first: { toolName: string; signature: string; error: string } | null =
    null;
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "assistant") continue;
    if (message.role !== "toolResult" || !message.isError) break;
    const error = toolResultContentToText(message.content);
    const signature = JSON.stringify([
      message.toolName,
      callArgs.get(message.toolCallId),
      error,
    ]);
    if (!first) first = { toolName: message.toolName, signature, error };
    else if (signature !== first.signature) break;
    count++;
  }

  return first && count >= MAX_REPEATED_TOOL_FAILURES
    ? `stopped after ${first.toolName} failed ${count} times in a row with the same arguments and error: ${first.error}`
    : null;
}

/**
 * Find the index of the last user message in the messages array.
 * Returns -1 if no user message found.
 */
function findFinalUserMessageIndex(messages: any[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

/**
 * Builds the system prompt from Pi's current instructions: every system
 * message in the transcript replayed in order, so later content is appended
 * and sections are replaced or removed. Pi's text is sent exactly as given.
 * The provider's own guidance follows it as separate paragraphs.
 *
 * `cwd` is Pi's workspace from the stream options. It is only stated when
 * Pi's instructions carry no cwd section, so SDK embeddings (whose host
 * process cwd differs) still tell Claude where Pi's tools run. The CLI's own
 * private temp directory is never offered as the workspace.
 */
export function buildSystemPrompt(
  context: { systemPrompt?: string; messages: any[] },
  replay = false,
  cwd?: string,
): string {
  const parts: string[] = [];

  const messages = normalizeContext(context as Context).messages;
  const instructions = getCurrentSystemPrompt(messages);
  if (instructions) {
    parts.push(instructions);
  }

  if (cwd && !getCurrentSystemMessage(messages)?.sections?.cwd) {
    parts.push(
      `Current working directory: ${cwd}\n` +
        "Pi's tools run in this workspace and resolve relative paths against it.",
    );
  }

  // When conversation history has tool results, instruct Claude to use them
  // instead of trying to re-call tools (which may not be available).
  if (context.messages?.some((m: any) => m.role === "toolResult")) {
    parts.push(
      "IMPORTANT: The conversation history below contains tool results from previously executed tools. " +
        "Use these results to answer the user's question. Do NOT attempt to re-call tools that already have results.",
    );
  }

  if (replay) {
    parts.push(
      "The conversation so far is given as <turn> blocks, oldest first. " +
        "Reply as the assistant to the last turn: answer the last user turn, or if the last turn is a tool result, continue from that result.",
    );
  }

  return parts.join("\n\n");
}

/**
 * Converts user message content to text.
 * Handles string content and array of content blocks.
 * Image blocks are replaced with placeholder text (HIST-02).
 * Increments the module-level placeholderImageCount for each image.
 */
function userContentToText(content: string | any[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const texts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      texts.push(block.text ?? "");
    } else if (block.type === "image") {
      texts.push("[An image was shared here but could not be included]");
      placeholderImageCount++;
    } else {
      console.warn(
        `[pi-claude-subscription] a "${block.type}" attachment in conversation history could not be included in the prompt`,
      );
    }
  }
  return texts.join("\n");
}

/**
 * Document blocks from a user message, sent to Claude as their own blocks.
 */
function documentBlocks(content: string | any[]): AnthropicContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b.type === "document" && b.source)
    .map((b) => ({ type: "document", source: b.source }));
}

/** The content with its document blocks removed, for text-only conversion. */
function withoutDocuments(content: string | any[]): string | any[] {
  if (!Array.isArray(content)) return content;
  return content.filter((b) => b.type !== "document");
}

/**
 * Converts assistant message content to text.
 * Handles string content and array of content blocks (text, thinking, toolCall).
 */
function contentToText(content: string | any[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (block.type === "text") return block.text ?? "";
      if (block.type === "thinking") return ""; // Skip thinking — internal reasoning, not conversation
      if (block.type === "toolCall") {
        const isCustom = isCustomToolName(block.name);
        if (isCustom) {
          // Custom tools: name the callable MCP name, marked as history, so
          // the model never mistakes the bare pi name for one it can call.
          const argsStr = block.arguments
            ? JSON.stringify(block.arguments)
            : "{}";
          return `Historical tool call (non-executable): ${CUSTOM_TOOLS_MCP_PREFIX}${block.name} args=${argsStr}`;
        }
        const claudeName = mapPiToolNameToClaude(block.name);
        const claudeArgs =
          block.arguments && typeof block.arguments === "object"
            ? translatePiArgsToClaude(
                block.name,
                block.arguments as Record<string, unknown>,
              )
            : block.arguments;
        const argsStr = claudeArgs ? JSON.stringify(claudeArgs) : "{}";
        return `Historical tool call (non-executable): ${claudeName} args=${argsStr}`;
      }
      // Unknown block types are represented as a placeholder
      return `[${block.type}]`;
    })
    .join("\n");
}

/**
 * Converts tool result content to text.
 * Handles string content and array of content blocks.
 * Image blocks get placeholder text (actual image passthrough handled separately).
 */
function toolResultContentToText(content: string | any[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const texts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      texts.push(block.text ?? "");
    } else if (block.type === "image") {
      texts.push("[An image was shared here but could not be included]");
      placeholderImageCount++;
    }
  }
  return texts.join("\n");
}

/**
 * Check if a tool result content array contains image blocks.
 */
function toolResultHasImages(content: string | any[]): boolean {
  if (typeof content === "string" || !Array.isArray(content)) return false;
  return content.some((block) => block.type === "image");
}
