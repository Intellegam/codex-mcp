# Codex MCP Server

MCP server that wraps the OpenAI Codex CLI to provide reliable session ID tracking for multi-turn conversations.

You MUST read the following file for more information:

- @README.md

## Overview

- **Language**: Node.js (CommonJS)
- **Protocol**: MCP (Model Context Protocol) over stdio
- **Dependency**: Requires `codex` CLI installed and configured

## Architecture

Single-file server (`server.js`) that:

1. Receives MCP JSON-RPC messages on stdin
2. Translates tool calls to `codex exec --json` CLI commands
3. Parses JSON output for session IDs and responses
4. Returns results via MCP protocol

## Tools Provided

- `codex` - Start a new Codex session (read-only sandbox)
- `codex-reply` - Continue an existing session using sessionId
- `codex-review` - Run code reviews (uncommitted, base branch, commit, or custom)

## Development

```bash
# Test locally
node server.js

# The server expects JSON-RPC on stdin
```

## Related

- Used by: `claude-plugins/plugins/codex/` (references via `github:Intellegam/codex-mcp`)
