# Codex CLI-based MCP Server

An MCP server implementation that uses Codex CLI internally to provide reliable session ID tracking for multi-turn conversations.

## Problem Solved

The native Codex MCP server (`mcp__codex__codex`) doesn't return session IDs, making it difficult to continue conversations using `mcp__codex__codex_reply`. This server uses the CLI with JSON output to get session IDs reliably.

## How It Works

1. Acts as an MCP server (speaks JSON-RPC protocol)
2. Translates MCP `codex` tool calls to `codex exec --json` CLI commands
3. Parses JSON output to extract session ID from `thread.started` event
4. Returns both response text AND `[SESSION_ID: xxx]` to the client
5. Translates MCP `codex-reply` calls to `codex exec resume` CLI commands
6. Translates MCP `codex-review` calls to `codex exec --json review` for non-interactive code reviews

## Prerequisites

- Node.js 14.0 or higher
- [Codex CLI](https://github.com/codex-cli/codex) installed and configured
- Claude Code installed

## Installation

### Quick install (recommended)

Run the server directly from GitHub via `npx`:

```bash
claude mcp add codex-agent -- npx -y github:hburrichter/codex-mcp
```

Verify it’s connected:

```bash
claude mcp list
```

### Project-local config (.mcp.json)

Add this to a project to auto‑load the server for that repo:

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

### Code reviews

Run the same review presets as `/review` in the interactive Codex CLI:

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

## Advantages Over Native MCP

- **Reliable session IDs**: Extracted directly from CLI JSON output, not guessed
- **No race conditions**: No filesystem scanning or timing issues
- **Full compatibility**: Uses the same CLI commands that work perfectly
- **Deterministic**: Session ID is guaranteed to be correct

## How It's Different

- **Native MCP**: Doesn't return session IDs, can't continue conversations
- **This wrapper**: Returns session IDs reliably by using CLI internally

## Limitations

- Slightly slower than native MCP (spawns CLI process)
- Requires Node.js to run the wrapper
