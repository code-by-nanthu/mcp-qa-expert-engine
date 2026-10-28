# Universal QA Expert Engine MCP Skill

An automated Model Context Protocol (MCP) server that instantly turns your favorite AI coding agents (Claude Code, Codex, Antigravity) into a Senior QA Automation and Manual Test Engineer.

## Quick Installation

Add this block directly to your agent's configuration file (e.g., `~/.xcode/claude_config.json` for Claude Code or your local IDE settings panel):

```json
{
  "mcpServers": {
    "qa-expert": {
      "command": "npx",
      "args": ["-y", "mcp-qa-expert-engine"]
    }
  }
}
```

## Features Exposed

* **`generate_qa_matrix`**: Analyzes your project workspace files or git diff inputs to structure complex Boundary Value and Equivalence Partitioning matrices.
