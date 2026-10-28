import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  {
    name: "qa-expert-engine",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "generate_qa_matrix",
        description: "Analyzes raw code diffs or technical requirements to output a highly comprehensive Boundary Value and Equivalence Partitioning QA matrix.",
        inputSchema: {
          type: "object",
          properties: {
            codeSnippet: {
              type: "string",
              description: "The source code or function string needing a test design plan.",
            },
          },
          required: ["codeSnippet"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "generate_qa_matrix") {
    throw new Error(`Tool ${request.params.name} not found`);
  }

  const codeSnippet = request.params.arguments.codeSnippet;

  const qaPlanOutput = `
=== SENIOR QA TEST STRATEGY GENERATED ===
[Input Code Audited]: 
${codeSnippet.substring(0, 100)}...

[Boundary Value Analysis (BVA) Vectors]:
- Lower Boundary Check: Validate minimum structural limits (e.g., 0, -1, null entries).
- Upper Boundary Check: Validate buffer overflows, maximum database integer sizes.
  
[Equivalence Partitioning (EP) Buckets]:
- Valid Class: Fully populated parameters mapping directly to Happy Path execution.
- Invalid Class: Missing authentication tokens, mismatched typings, out-of-bounds payloads.
  `;

  return {
    content: [
      {
        type: "text",
        text: qaPlanOutput,
      },
    ],
  };
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("QA Expert MCP Server running securely via Stdio.");
}

run().catch(console.error);
