/**
 * Tool discovery and MCP config file generation.
 *
 * Discovers tools from pi, writes their schemas to a temp file,
 * and generates an MCP config that points to the schema-only MCP server.
 */

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/** A Pi tool definition with MCP-compatible schema. */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Get every tool definition from pi. Claude Code's own tools are off, so Pi's
 * built-in tools are served through the schema-only MCP server as well.
 *
 * @param pi - The pi ExtensionAPI instance
 * @returns Array of tool definitions (empty if pi has none registered)
 */
export function getToolDefs(pi: any): McpToolDef[] {
  const allTools = pi.getAllTools();

  if (!Array.isArray(allTools)) {
    return [];
  }

  return allTools.map((tool: any) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
  }));
}

/**
 * Write MCP config and tool schemas to temp files.
 *
 * Creates two temp files:
 * 1. Schema file: JSON array of tool definitions
 * 2. Config file: MCP config pointing to the schema-only server
 *
 * @param toolDefs - Array of tool definitions
 * @returns Path to the MCP config file
 */
export function writeMcpConfig(toolDefs: McpToolDef[]): string {
  // Write tool schemas to temp file
  const schemaFilePath = join(
    tmpdir(),
    `pi-claude-mcp-schemas-${process.pid}.json`,
  );
  writeFileSync(schemaFilePath, JSON.stringify(toolDefs));

  // Resolve path to the schema server .cjs file (sibling of this module)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const serverPath = join(__dirname, "mcp-schema-server.cjs");

  // Build MCP config
  const config = {
    mcpServers: {
      "custom-tools": {
        command: "node",
        args: [serverPath, schemaFilePath],
      },
    },
  };

  // Write config to temp file
  const configFilePath = join(
    tmpdir(),
    `pi-claude-mcp-config-${process.pid}.json`,
  );
  writeFileSync(configFilePath, JSON.stringify(config));

  return configFilePath;
}
