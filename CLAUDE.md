# Codex MCP Server

MCP server that wraps the Codex app-server JSON-RPC protocol to provide session tracking for multi-turn conversations with async job support.

You MUST read the following file for more information:

- @README.md

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

## Development

```bash
# Run tests
bun test

# Test locally (sync)
node test/send.js codex "prompt"

# Test locally (async)
node test/send.js codex --async "prompt"

# Test new tools
node test/send.js codex-result <sessionId>
node test/send.js codex-cancel <sessionId>
```

## Releasing

When bumping the version, update all of these:

1. `package.json` — `version` field
2. `server.js` — `VERSION` constant
3. Create a git tag: `git tag v{version} && git push origin v{version}`
4. In `claude-plugins/plugins/codex/.mcp.json` — update `#v{version}` tag pin
5. In `claude-plugins/` — bump version in both `plugin.json` and `marketplace.json`

The `.mcp.json` uses `bunx github:Intellegam/codex-mcp#v{version}` with a pinned tag. Bunx aggressively caches bare `github:` refs, so the tag pin is required.

## Related

- Used by: `claude-plugins/plugins/codex/` (references via `github:Intellegam/codex-mcp`)
- Protocol docs: https://developers.openai.com/codex/app-server
