#!/usr/bin/env node
/**
 * Universal QA Expert Engine — MCP Server
 *
 * Eight QA tools over stdio JSON-RPC 2.0. Tool implementations live in
 * lib/tools/; this file only wires the SDK transport and boots.
 *
 * Protocol invariant: stdout carries protocol JSON only. Every diagnostic,
 * boot notice, and subprocess log goes to stderr or into a tool result payload.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { WORKSPACE_ROOT } from "./lib/config.js";
import { ToolInputError } from "./lib/errors.js";
import { toolError } from "./lib/format/result.js";
import { HANDLERS, TOOLS } from "./lib/tools/registry.js";

const server = new Server(
  { name: "qa-expert-engine", version: "1.2.1" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params?.name;
  const handler = HANDLERS[toolName];

  if (!handler) {
    return toolError(`Unknown tool "${toolName}".`, {
      availableTools: TOOLS.map((t) => t.name),
    });
  }

  // No handler fault may escape as an unhandled protocol error.
  try {
    return await handler(request.params.arguments);
  } catch (error) {
    if (error instanceof ToolInputError) {
      return toolError(`Invalid input for "${toolName}": ${error.message}`, error.details);
    }
    console.error(`[qa-expert-engine] ${toolName} failed:`, error);
    return toolError(
      `Tool "${toolName}" failed unexpectedly: ${error?.message ?? String(error)}`
    );
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is reserved for the JSON-RPC stream.
  console.error(
    `QA Expert MCP Server running via stdio. ${TOOLS.length} tools registered. Workspace: ${WORKSPACE_ROOT}`
  );
}

run().catch((error) => {
  console.error("[qa-expert-engine] fatal:", error);
  process.exit(1);
});

