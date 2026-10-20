/**
 * Single-source-of-truth tool mapping table for bidirectional translation
 * between Claude CLI tool names/arguments and pi tool names/arguments.
 *
 * All lookup tables are derived from the TOOL_MAPPINGS array.
 * Unknown tools and arguments pass through unchanged.
 */

/**
 * A mapping entry for a single tool.
 * `args` maps Claude argument names to pi argument names (only renamed args).
 */
export interface ToolMapping {
  claude: string;
  pi: string;
  args: Record<string, string>;
}

/**
 * The canonical tool mapping table. All other lookup structures are derived from this.
 */
export const TOOL_MAPPINGS: ToolMapping[] = [
  { claude: "Read", pi: "read", args: { file_path: "path" } },
  { claude: "Write", pi: "write", args: { file_path: "path" } },
  {
    claude: "Edit",
    pi: "edit",
    args: { file_path: "path", old_string: "oldText", new_string: "newText" },
  },
  { claude: "Bash", pi: "bash", args: {} },
  { claude: "Grep", pi: "grep", args: { head_limit: "limit" } },
  { claude: "Glob", pi: "find", args: {} },
];

/** Prefix for custom pi tools exposed via MCP. */
export const CUSTOM_TOOLS_MCP_PREFIX = "mcp__custom-tools__";

/** Set of built-in pi tool names derived from TOOL_MAPPINGS for O(1) lookup. */
const BUILT_IN_PI_NAMES = new Set(TOOL_MAPPINGS.map((m) => m.pi));

/**
 * Check if a pi tool name is a custom tool (not one of the 6 built-in tools).
 * Used by prompt builder to decide whether to add MCP prefix in history replay.
 */
export function isCustomToolName(piName: string): boolean {
  return !BUILT_IN_PI_NAMES.has(piName);
}

// Derived lookup maps

/** Lowercase Claude name -> pi name */
const CLAUDE_TO_PI_NAME: Record<string, string> = {};
/** Pi name -> PascalCase Claude name */
const PI_TO_CLAUDE_NAME: Record<string, string> = {};
/** Lowercase Claude name -> { claudeArgName: piArgName } */
const CLAUDE_TO_PI_ARGS: Record<string, Record<string, string>> = {};
/** Pi name -> { piArgName: claudeArgName } */
const PI_TO_CLAUDE_ARGS: Record<string, Record<string, string>> = {};

for (const m of TOOL_MAPPINGS) {
  CLAUDE_TO_PI_NAME[m.claude.toLowerCase()] = m.pi;
  PI_TO_CLAUDE_NAME[m.pi] = m.claude;
  CLAUDE_TO_PI_ARGS[m.claude.toLowerCase()] = m.args;

  // Build reverse arg map
  const reverseArgs: Record<string, string> = {};
  for (const [from, to] of Object.entries(m.args)) {
    reverseArgs[to] = from;
  }
  PI_TO_CLAUDE_ARGS[m.pi] = reverseArgs;
}

// Handle glob/find asymmetry: pi's "glob" also maps back to Claude's "Glob"
PI_TO_CLAUDE_NAME["glob"] = "Glob";

/** Any MCP server prefix, e.g. "mcp__custom-tools__" or "mcp__other__". */
const MCP_PREFIX = /^mcp__.+?__/;

/** Claude Code's own tools. The CLI runs these itself; pi has no equivalent. */
const INTERNAL_CLAUDE_TOOLS = new Set(["toolsearch", "task", "agent"]);

/** True for CLI-internal tools (ToolSearch, Task, Agent) that pi must not see. */
export function isInternalClaudeTool(claudeName: string): boolean {
  return INTERNAL_CLAUDE_TOOLS.has(claudeName.toLowerCase());
}

/**
 * Map a Claude tool name to the corresponding pi tool name.
 * Strips any mcp__<server>__ prefix first, then falls back to
 * case-insensitive built-in lookup. When pi's tool names are given and the
 * result is not one of them, a pi name that differs only by "-" vs "_" wins
 * (models call mcp__t3_code__x for pi's mcp__t3-code__x). Never throws:
 * unknown tool names pass through so pi's unknown-tool error drives
 * self-correction.
 */
export function mapClaudeToolNameToPi(
  claudeName: string,
  piToolNames?: readonly string[],
): string {
  // e.g., "mcp__custom-tools__deploy" -> "deploy"
  const bare = claudeName.replace(MCP_PREFIX, "");
  const mapped =
    bare !== claudeName
      ? bare
      : (CLAUDE_TO_PI_NAME[claudeName.toLowerCase()] ?? claudeName);
  if (!piToolNames || piToolNames.includes(mapped)) return mapped;
  const key = (name: string) => name.replace(/-/g, "_");
  return piToolNames.find((name) => key(name) === key(mapped)) ?? mapped;
}

/**
 * Map a pi tool name to the corresponding Claude tool name.
 * Direct lookup. Unknown tool names pass through unchanged.
 */
export function mapPiToolNameToClaude(piName: string): string {
  return PI_TO_CLAUDE_NAME[piName] ?? piName;
}

/**
 * Translate Claude tool arguments to pi format.
 * Only known renamed arguments are translated; all others pass through unchanged.
 * This prevents dropping unknown/extra arguments (Pitfall 5).
 */
export function translateClaudeArgsToPi(
  claudeToolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const renames = CLAUDE_TO_PI_ARGS[claudeToolName.toLowerCase()];
  if (!renames || Object.keys(renames).length === 0) return args;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const newKey = renames[key] ?? key;
    result[newKey] = value;
  }
  return result;
}

/**
 * Translate pi tool arguments to Claude format.
 * Only known renamed arguments are translated; all others pass through unchanged.
 */
export function translatePiArgsToClaude(
  piToolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const renames = PI_TO_CLAUDE_ARGS[piToolName];
  if (!renames || Object.keys(renames).length === 0) return args;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const newKey = renames[key] ?? key;
    result[newKey] = value;
  }
  return result;
}

/**
 * Names of the tools Pi can execute for this request. Pi folds tools into
 * system messages (toolsAdded/toolsRemoved) before calling the provider, so
 * context.tools is normally absent; it is used when present.
 */
export function getPiToolNames(context: {
  messages: any[];
  tools?: { name: string }[];
}): string[] {
  if (context.tools?.length) return context.tools.map((t) => t.name);
  const names = new Set<string>();
  for (const m of context.messages ?? []) {
    if (m?.role !== "system") continue;
    for (const t of m.toolsRemoved ?? []) names.delete(t.name);
    for (const t of m.toolsAdded ?? []) names.add(t.name);
  }
  return [...names];
}
