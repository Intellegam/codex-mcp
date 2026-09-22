# Codex MCP Server

MCP server that wraps the Codex app-server JSON-RPC protocol to provide session tracking for multi-turn conversations with async job support.

Consult `README.md` for setup and usage when needed.

## Overview

- **Language**: Node.js (CommonJS)
- **Protocol**: MCP (Model Context Protocol) over stdio → Codex app-server JSON-RPC
- **Dependency**: Requires `codex` CLI installed with `app-server` support

## Architecture

Single-file server (`server.js`) with an async-first turn engine:

1. Receives MCP JSON-RPC messages on stdin
2. Spawns a single `codex app-server` process per MCP connection
3. Translates tool calls to app-server RPC methods (`thread/start`, `turn/start`, `review/start`)
4. Tracks turns in an in-memory Map with state machine (`starting` → `running` → terminal)
5. Sync tools are thin wrappers that `await turn.donePromise`
6. Returns results via MCP protocol with thread IDs as session IDs

## Tools Provided

- `codex` - Start a new Codex session (supports `async: true` for non-blocking calls)
- `codex-reply` - Continue an existing session using sessionId (supports `async: true`)
- `codex-review` - Run code reviews (supports `async: true`)
- `codex-result` - Get session status/result (supports `wait: true` to block until done)
- `codex-cancel` - Cancel the active turn on a session

## Commands & Checks

### Required Checks

- Test: `bun test` (the repository's automated test suite)

### Situational Checks

- Real Codex integration smoke: `bun run test:smoke` when explicitly requested;
  this invokes the installed Codex CLI and may consume model usage.

### Manual Diagnostics

The following commands operate real sessions; use only for an authorized
integration investigation. They are not required for documentation-only edits.

```bash
# Test locally (sync)
node test/send.js codex "prompt"

# Test locally (async)
node test/send.js codex --async "prompt"

# Test new tools
node test/send.js codex-result <sessionId>
node test/send.js codex-cancel <sessionId>
```

## Releasing

See `RELEASING.md` when preparing a release.

## Related

- Used by: `agent-plugins/plugins/codex/` (references via `github:Intellegam/codex-mcp`)
- Protocol docs: https://developers.openai.com/codex/app-server
