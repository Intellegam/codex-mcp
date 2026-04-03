# Codex MCP Server

MCP server that wraps the Codex app-server JSON-RPC protocol to provide session tracking for multi-turn conversations.

You MUST read the following file for more information:

- @README.md

## Overview

- **Language**: Node.js (CommonJS)
- **Protocol**: MCP (Model Context Protocol) over stdio → Codex app-server JSON-RPC
- **Dependency**: Requires `codex` CLI installed with `app-server` support

## Architecture

Single-file server (`server.js`) that:

1. Receives MCP JSON-RPC messages on stdin
2. Spawns a single `codex app-server` process per MCP connection
3. Translates tool calls to app-server RPC methods (`thread/start`, `turn/start`, `review/start`)
4. Collects streaming notifications until `turn/completed` with configurable timeouts
5. Returns results via MCP protocol with thread IDs as session IDs

## Tools Provided

- `codex` - Start a new Codex session (read-only by default, `writable: true` for workspace writes)
- `codex-reply` - Continue an existing session using sessionId (thread/resume + turn/start)
- `codex-review` - Run code reviews (uncommitted, base branch, commit, or custom)

## Development

```bash
# Test locally
node server.js

# The server expects JSON-RPC on stdin
# App-server schemas can be regenerated with:
codex app-server generate-json-schema --out ./schemas
```

## Related

- Used by: `claude-plugins/plugins/codex/` (references via `github:Intellegam/codex-mcp`)
- Protocol docs: https://developers.openai.com/codex/app-server
