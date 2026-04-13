# Codex MCP Server

MCP server that wraps the Codex app-server JSON-RPC protocol to provide session tracking for multi-turn conversations with async job support.

You MUST read the following file for more information:

- @README.md

## Overview

- **Language**: Node.js (CommonJS)
- **Protocol**: MCP (Model Context Protocol) over stdio → Codex app-server JSON-RPC
- **Dependency**: Requires `codex` CLI installed with `app-server` support

## Architecture

Single-file server (`server.js`) with an async-first job engine:

1. Receives MCP JSON-RPC messages on stdin
2. Spawns a single `codex app-server` process per MCP connection
3. Translates tool calls to app-server RPC methods (`thread/start`, `turn/start`, `review/start`)
4. Tracks jobs in an in-memory Map with state machine (`starting` → `running` → terminal)
5. Sync tools are thin wrappers that `await job.donePromise`
6. Returns results via MCP protocol with thread IDs as session IDs

## Tools Provided

- `codex` - Start a new Codex session (supports `async: true` for non-blocking calls)
- `codex-reply` - Continue an existing session using sessionId (supports `async: true`)
- `codex-review` - Run code reviews (supports `async: true`)
- `codex-result` - Poll for async job status/result (supports `waitMs` for long-polling)
- `codex-cancel` - Cancel a running async job

## Development

```bash
# Run tests
bun test

# Test locally (sync)
node test/send.js codex "prompt"

# Test locally (async)
node test/send.js codex --async "prompt"

# Test new tools
node test/send.js codex-result <jobId>
node test/send.js codex-cancel <jobId>
```

## Related

- Used by: `claude-plugins/plugins/codex/` (references via `github:Intellegam/codex-mcp`)
- Protocol docs: https://developers.openai.com/codex/app-server
