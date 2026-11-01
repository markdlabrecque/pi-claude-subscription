/**
 * Tool discovery and MCP config file generation.
 *
 * Discovers tools from pi, writes their schemas to a temp file,
 * and generates an MCP config that points to the schema-only MCP server.
 */

import { rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SCHEMAS_PREFIX = "pi-claude-mcp-schemas-";
const CONFIG_PREFIX = "pi-claude-mcp-config-";

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
 * Map the tools Pi offers for one request to MCP definitions, keeping each
 * name, description and schema exactly as offered.
 */
export function toMcpToolDefs(
  tools: readonly { name: string; description: string; parameters: unknown }[],
): McpToolDef[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as Record<string, unknown>,
  }));
}

/**
 * Write MCP config and tool schemas to temp files.
 *
 * Creates two temp files, unique per call, for removeMcpConfig to delete:
 * 1. Schema file: JSON array of tool definitions
 * 2. Config file: MCP config pointing to the schema-only server
 *
 * @param toolDefs - Array of tool definitions
 * @returns Path to the MCP config file
 */
export function writeMcpConfig(toolDefs: McpToolDef[]): string {
  const id = `${process.pid}-${randomUUID()}`;

  // Write tool schemas to temp file
  const schemaFilePath = join(tmpdir(), `${SCHEMAS_PREFIX}${id}.json`);
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
  const configFilePath = join(tmpdir(), `${CONFIG_PREFIX}${id}.json`);
  try {
    writeFileSync(configFilePath, JSON.stringify(config));
  } catch (err) {
    rmSync(schemaFilePath, { force: true });
    throw err;
  }

  return configFilePath;
}

/**
 * Remove the files writeMcpConfig made for this config path. Paths that
 * writeMcpConfig did not produce are left alone.
 */
export function removeMcpConfig(configFilePath: string): void {
  const name = basename(configFilePath);
  if (!name.startsWith(CONFIG_PREFIX)) return;
  rmSync(configFilePath, { force: true });
  rmSync(
    join(
      dirname(configFilePath),
      SCHEMAS_PREFIX + name.slice(CONFIG_PREFIX.length),
    ),
    { force: true },
  );
}
