# Codex MCP Server

An MCP server that communicates with Codex via the [app-server](https://developers.openai.com/codex/app-server) JSON-RPC protocol, providing reliable session tracking for multi-turn conversations with timeout protection.

## How It Works

1. Acts as an MCP server (speaks JSON-RPC protocol over stdio)
2. Spawns a single `codex app-server` process per MCP connection
3. Translates MCP tool calls to app-server RPC methods (`thread/start`, `turn/start`, `review/start`)
4. Collects streaming notifications until `turn/completed`
5. Returns response text and `[SESSION_ID: xxx]` (the Codex thread ID) to the client
6. Enforces configurable timeouts (default 5 minutes) to prevent indefinite hangs

## Prerequisites

- Node.js 18.0 or higher
- [Codex CLI](https://github.com/openai/codex) installed, configured, and supporting `codex app-server`
- Claude Code installed

## Installation

### Quick install (recommended)

Run the server directly from GitHub via `npx`:

```bash
claude mcp add codex-agent -- npx -y github:hburrichter/codex-mcp
```

Verify it's connected:

```bash
claude mcp list
```

### Project-local config (.mcp.json)

Add this to a project to auto-load the server for that repo:

```json
{
  "mcpServers": {
    "codex-agent": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:hburrichter/codex-mcp"],
      "env": {}
    }
  }
}
```

### Alternative: local clone

If you prefer a local checkout:

```bash
git clone https://github.com/hburrichter/codex-mcp ~/.claude/mcp-servers/codex-agent
claude mcp add --transport stdio codex-agent -- node ~/.claude/mcp-servers/codex-agent/server.js
```

**Note:** Tools will be namespaced under whatever server name you choose.

## Usage

Once configured, use the MCP tools as normal. The response will include the session ID:

```
Response: "Here's the answer..."
[SESSION_ID: 019a7661-3643-7ac3-aeb9-098a910935fb]
```

Extract the ID and use it for follow-ups:

```javascript
mcp__codex__codex_reply({
  sessionId: "019a7661-3643-7ac3-aeb9-098a910935fb",
  prompt: "follow-up question"
})
```

Within the same MCP connection, follow-ups work immediately. Across MCP reconnections, pass `cwd` to help the app-server locate the persisted thread on disk:

```javascript
mcp__codex__codex_reply({
  sessionId: "019a7661-3643-7ac3-aeb9-098a910935fb",
  prompt: "follow-up question",
  cwd: "/path/to/original/repo"
})
```

### Code reviews

Reviews are ephemeral — they do not return a session ID and cannot be resumed. Use `codex` instead of `codex-review` if follow-up discussion is needed.

```javascript
// Review uncommitted changes
mcp__codex__codex_review({ mode: "uncommitted", cwd: "/path/to/repo" })

// Review against base branch
mcp__codex__codex_review({ mode: "base", base: "main", cwd: "/path/to/repo" })

// Review a commit
mcp__codex__codex_review({ mode: "commit", commit: "e119e00", cwd: "/path/to/repo" })

// Custom review instructions
mcp__codex__codex_review({ mode: "custom", prompt: "Focus on security issues.", cwd: "/path/to/repo" })
```

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `CODEX_TIMEOUT_MS` | `300000` (5 min) | Maximum time to wait for a Codex response before timing out |

## Architecture

Uses the Codex app-server JSON-RPC protocol instead of CLI subprocess calls:

- **Per-connection lifecycle**: One `codex app-server` process per MCP connection, isolated between concurrent Claude sessions
- **Formal protocol**: Bidirectional JSON-RPC 2.0 with typed requests/responses and streaming notifications
- **Timeout protection**: Configurable timeouts with `turn/interrupt` on expiry to prevent ghost turns
- **Clean shutdown**: App server process is terminated on SIGINT, SIGTERM, or stdin close
- **Session resume**: Non-ephemeral threads are persisted to `~/.codex/sessions/` by Codex after the first completed turn. `thread/resume` with `threadId` + `cwd` reloads them in a fresh app-server connection. Within the same connection, threads are already loaded and `turn/start` works directly (tracked via `loadedThreads` set)
- **Parallel-safe notifications**: Each active turn registers a handler keyed by thread ID, so concurrent tool calls on different threads dispatch independently
