/**
 * Prompt builder for flattening pi conversation history into a labeled text prompt.
 *
 * Follows the reference project's buildPromptBlocks() pattern:
 * - USER: / ASSISTANT: / TOOL RESULT: labels
 * - Content blocks serialized by type
 * - Images in user messages and tool results, and documents in user messages,
 *   are passed through as Anthropic API blocks right after their message
 */

import {
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
 * Anthropic API content block types for passthrough (images and documents),
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
  if (isValidImage(piBlock)) {
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

/** Whether any user message or tool result carries a block sent as-is. */
function anyPassthrough(messages: any[]): boolean {
  return messages.some(
    (m) =>
      (m.role === "user" && documentBlocks(m.content).length > 0) ||
      (m.role !== "assistant" && imageBlocks(m.content).length > 0),
  );
}

/** Image blocks from a user message or tool result, in Anthropic format. */
function imageBlocks(content: string | any[]): AnthropicContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((b) =>
    b.type === "image" ? (translateImageBlock(b) ?? []) : [],
  );
}

/** The content with its passed-through images and documents removed. */
function withoutPassthrough(content: string | any[]): string | any[] {
  if (!Array.isArray(content)) return content;
  return content.filter(
    (b) => b.type !== "document" && !(b.type === "image" && isValidImage(b)),
  );
}

/**
 * Labeled history text with each message's images and documents as their own
 * blocks right after that message's text.
 */
function createBlockList() {
  const blocks: AnthropicContentBlock[] = [];
  let lines: string[] = [];
  const flush = () => {
    if (lines.length === 0) return;
    blocks.push({ type: "text", text: lines.join("\n") });
    lines = [];
  };
  return {
    text: (...parts: string[]) => void lines.push(...parts),
    attach: (attachments: AnthropicContentBlock[]) => {
      if (attachments.length === 0) return;
      flush();
      blocks.push(...attachments);
    },
    /** The blocks, or plain text when nothing was attached. */
    result: (): string | AnthropicContentBlock[] => {
      if (blocks.length === 0) return lines.join("\n") || "";
      flush();
      return blocks;
    },
  };
}

/** The label line that introduces a tool result in history text. */
function toolResultLabel(toolName?: string): string {
  // Custom tools: don't reference MCP tool name. Present result plainly.
  if (toolName && isCustomToolName(toolName))
    return `TOOL RESULT (${toolName}):`;
  const claudeToolName = toolName ? mapPiToolNameToClaude(toolName) : "unknown";
  return `TOOL RESULT (historical ${claudeToolName}):`;
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

  // Pi continuing its tool loop: the session already holds the user turn,
  // so send only what follows the last assistant turn (its tool results).
  for (let i = messages.length - 1; i > finalUserIndex; i--) {
    if (messages[i].role === "assistant") {
      startIdx = i + 1;
      break;
    }
  }

  for (let i = startIdx; i < messages.length; i++) {
    newMessages.push(messages[i]);
  }

  // Tool results as labeled text, then the user message. Images and documents
  // follow the text of the message they came with.
  const list = createBlockList();
  for (const msg of newMessages) {
    if (msg.role === "toolResult") {
      list.text(
        toolResultLabel(msg.toolName),
        toolResultContentToText(withoutPassthrough(msg.content)),
      );
      list.attach(imageBlocks(msg.content));
    } else if (msg.role === "user") {
      if (contentHasPassthrough(msg.content)) {
        list.attach(buildFinalUserContent(msg.content));
      } else {
        list.text(userContentToText(msg.content));
      }
    }
  }

  return list.result();
}

/**
 * Build the prompt for replay mode: one text block per history message, oldest
 * first, each wrapped in a <turn> tag. Tool calls and results ride along as
 * text inside their turns. Documents in a user turn, then images in a user or
 * tool turn, follow that turn as their own blocks.
 *
 * Block bytes depend only on their own message, so earlier blocks stay stable
 * between turns and hit the prompt cache.
 */
export function buildReplayPrompt(context: {
  messages: any[];
}): AnthropicContentBlock[] {
  placeholderImageCount = 0;
  const blocks: AnthropicContentBlock[] = [];

  for (const message of context.messages) {
    let tag: string;
    let text: string;
    if (message.role === "user") {
      tag = `<turn role="user">`;
      text = userContentToText(withoutPassthrough(message.content));
    } else if (message.role === "assistant") {
      tag = `<turn role="assistant">`;
      text = contentToText(message.content);
    } else if (message.role === "toolResult") {
      tag = `<turn role="tool"${message.toolName ? ` name="${message.toolName}"` : ""}>`;
      text = toolResultContentToText(withoutPassthrough(message.content));
    } else {
      continue;
    }
    blocks.push({ type: "text", text: `${tag}\n${text}\n</turn>` });
    if (message.role === "user")
      blocks.push(...documentBlocks(message.content));
    if (message.role !== "assistant")
      blocks.push(...imageBlocks(message.content));
  }

  warnAboutPlaceholders();
  return blocks;
}

export function buildPrompt(context: {
  messages: any[];
}): string | AnthropicContentBlock[] {
  // Reset placeholder counter for each call
  placeholderImageCount = 0;
  const messages = context.messages;

  if (anyPassthrough(messages)) {
    // Each message's images and documents follow its text. A user message
    // that ends the conversation is sent as it came, without a label.
    const list = createBlockList();
    messages.forEach((message, i) => {
      if (message.role === "user") {
        if (i === messages.length - 1) {
          list.attach(buildFinalUserContent(message.content));
          return;
        }
        list.text(
          "USER:",
          userContentToText(withoutPassthrough(message.content)),
        );
        list.attach([
          ...documentBlocks(message.content),
          ...imageBlocks(message.content),
        ]);
      } else if (message.role === "assistant") {
        list.text("ASSISTANT:", contentToText(message.content));
      } else if (message.role === "toolResult") {
        list.text(
          toolResultLabel(message.toolName),
          toolResultContentToText(withoutPassthrough(message.content)),
        );
        list.attach(imageBlocks(message.content));
      }
    });
    warnAboutPlaceholders();
    return list.result();
  }

  // Special case: when conversation ends with a custom tool result,
  // present it directly instead of complex history replay
  const customToolPrompt = buildCustomToolResultPrompt(messages);
  if (customToolPrompt) {
    // customToolPrompt calls userContentToText which may increment placeholderImageCount
    warnAboutPlaceholders();
    return customToolPrompt;
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
      parts.push(toolResultLabel(message.toolName));
      parts.push(toolResultContentToText(message.content));
    }
  }

  warnAboutPlaceholders();
  return parts.join("\n") || "";
}

/** Warn once when images had to be replaced by placeholder text. */
function warnAboutPlaceholders(): void {
  if (placeholderImageCount > 0) {
    console.warn(
      `[pi-claude-subscription] ${placeholderImageCount} image(s) in conversation history could not be included in the prompt`,
    );
  }
}

/**
 * Describe the first block the request would send that cannot reach Claude
 * intact, or null if there is none. Rejecting it up front keeps attachments
 * from being dropped or replaced by a placeholder silently.
 *
 * User messages carry text, images and documents with a source; tool results
 * carry text and images. A resumed CLI session already holds everything up to
 * the last assistant turn, so only what follows it is checked.
 */
export function findUnsupportedAttachment(
  messages: any[],
  resumed = false,
): string | null {
  let start = 0;
  if (resumed) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        start = i + 1;
        break;
      }
    }
  }

  for (let i = start; i < messages.length; i++) {
    const { role, content } = messages[i];
    if (!Array.isArray(content)) continue;
    if (role !== "user" && role !== "toolResult") continue;
    for (const block of content) {
      if (block.type === "text") continue;
      if (block.type === "image") {
        if (!isValidImage(block)) return MALFORMED_IMAGE;
        continue;
      }
      if (role === "user") {
        if (block.type === "document" && block.source) continue;
        return `"${block.type}" attachments are not supported by pi-claude-subscription; only text, images, and documents can be sent.`;
      }
      return `"${block.type}" attachments are not supported by pi-claude-subscription in tool results; only text and images can be sent.`;
    }
  }
  return null;
}

const MALFORMED_IMAGE =
  "an image attachment is malformed and cannot be sent by pi-claude-subscription; it needs non-empty base64 data and a media type.";

/** Whether an image block has the data and media type Claude needs. */
function isValidImage(block: any): boolean {
  return (
    typeof block.data === "string" &&
    block.data !== "" &&
    typeof block.mimeType === "string" &&
    block.mimeType !== ""
  );
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
 */
export function buildSystemPrompt(
  context: { systemPrompt?: string; messages: any[] },
  replay = false,
): string {
  const parts: string[] = [];

  const instructions = getCurrentSystemPrompt(
    normalizeContext(context as Context).messages,
  );
  if (instructions) {
    parts.push(instructions);
  }

  // Replay must carry the same guidance before and after the first tool
  // result. Adding it only once a result exists invalidates the cache prefix.
  if (replay || context.messages?.some((m: any) => m.role === "toolResult")) {
    parts.push(
      "IMPORTANT: If the conversation history below contains tool results from previously executed tools, " +
        "use these results to answer the user's question. Do NOT attempt to re-call tools that already have results.",
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
