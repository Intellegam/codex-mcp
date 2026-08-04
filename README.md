# Codex MCP Server

An MCP server that communicates with Codex via the [app-server](https://developers.openai.com/codex/app-server) JSON-RPC protocol, providing reliable session tracking for multi-turn conversations with timeout protection and async job support.

## How It Works

1. Acts as an MCP server (speaks JSON-RPC protocol over stdio)
2. Spawns a single `codex app-server` process per MCP connection
3. Translates MCP tool calls to app-server RPC methods (`thread/start`, `turn/start`, `review/start`)
4. Collects streaming notifications until `turn/completed`
5. Returns structured results with session IDs for multi-turn conversations
6. Enforces configurable timeouts (default 30 minutes) to prevent indefinite hangs
7. Supports async mode — return a sessionId immediately and poll for results

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

## Tools

### `codex` — Start a new session

```
// Synchronous (blocks until Codex responds)
codex({ prompt: "Explain this codebase" })

// Asynchronous (returns sessionId immediately)
codex({ prompt: "Explain this codebase", async: true })
```

Optional parameters: `cwd`, `writable` (default false), `async` (default false).

### `codex-reply` — Continue an existing session

```
codex-reply({ sessionId: "019a...", prompt: "follow-up question" })
```

Within the same MCP connection, follow-ups work immediately. Across MCP reconnections, pass `cwd` to help the app-server locate the persisted thread on disk.

### `codex-review` — Code review

Reviews return a session ID and can be continued with `codex-reply` for
follow-up discussion while the same app-server connection is alive (e.g.,
"explain finding #3 in more detail"). Review threads are ephemeral, so they do
not appear in persistent Codex history and cannot be resumed after an app-server
restart.

```
// Review uncommitted changes
codex-review({ mode: "uncommitted", cwd: "/path/to/repo" })

// Review against base branch
codex-review({ mode: "base", base: "main", cwd: "/path/to/repo" })

// Review a commit
codex-review({ mode: "commit", commit: "e119e00", cwd: "/path/to/repo" })

// Custom review instructions
codex-review({ mode: "custom", prompt: "Focus on security issues.", cwd: "/path/to/repo" })
```

### `codex-result` — Poll for latest turn result

```
// Immediate check
codex-result({ sessionId: "019a..." })

// Block until done
codex-result({ sessionId: "019a...", wait: true })
```

Returns the latest turn's snapshot with `status`, `done`, `output`, `error`, etc.

### `codex-cancel` — Cancel the active turn

```
codex-cancel({ sessionId: "019a..." })
```

If a turn is still in progress, sends an interrupt. If no active turn or already completed, returns the current state unchanged.

## Async Mode

Use `async: true` when you have other work to do while Codex thinks — editing files, running tests, consulting other tools. If you would just poll in a loop, use sync (the default) instead.

```
// 1. Start async — returns sessionId immediately
codex({ prompt: "Complex analysis task", async: true })
// → { sessionId: "019a...", status: "starting", done: false }

// 2. Wait for the result
codex-result({ sessionId: "019a...", wait: true })
// → { sessionId: "019a...", status: "succeeded", output: "...", done: true }

// 3. Continue the conversation (same sessionId)
codex-reply({ sessionId: "019a...", prompt: "follow-up" })

// 4. Cancel if needed
codex-cancel({ sessionId: "019a..." })
```

`sessionId` is the only identifier — it works for `codex-reply`, `codex-result`, and `codex-cancel`.

Turn states: `starting` → `running` → `succeeded` | `failed` | `cancelled` | `timed_out`

Polling state is in-memory and connection-scoped. Non-review Codex threads are
persistent and can be resumed by `codex-reply` after an MCP restart using their
session ID (and matching `cwd`). Review threads are ephemeral and only support
follow-up while their original app-server connection is alive.

### Thread history lifecycle

- `codex-review` creates an ephemeral Codex thread.
- `codex` creates a persistent thread. Persistent threads are archived after a
  synchronous terminal response has been written to the MCP caller.
- In async mode, persistent threads remain unarchived until `codex-result`
  delivers a terminal snapshot. A `codex-cancel` response alone does not
  archive the thread.
- A later `codex-reply` automatically unarchives and resumes a persistent
  thread. Archived state is recovered whether Codex reports it while reloading
  the thread or while starting the follow-up turn. The thread is archived again
  after delivering the result.
- Archival is best-effort. Failure never replaces the task result; it is logged
  on stderr and exposed as `archiveError` on later result snapshots. Ambiguous
  archive failures invalidate cached load state so the next reply reconciles
  against Codex instead of trusting stale in-memory state.

### Parallel Sessions

Multiple async sessions can run at the same time. Each session is independent, so there is no contention between them.

```
// Fan out — start reviews concurrently
codex-review({ mode: "base", base: "main", cwd: "/repo", async: true })
// → { sessionId: "aaa..." }

codex-review({ mode: "custom", prompt: "Focus on security", cwd: "/repo", async: true })
// → { sessionId: "bbb..." }

// Collect — wait for all results in parallel
codex-result({ sessionId: "aaa...", wait: true })
codex-result({ sessionId: "bbb...", wait: true })
```

This works for any combination of `codex`, `codex-reply`, and `codex-review` — not just reviews.

## Configuration

| Environment Variable        | Default            | Description                                             |
| --------------------------- | ------------------ | ------------------------------------------------------- |
| `CODEX_TIMEOUT_MS`          | `1800000` (30 min) | Maximum time to wait for a Codex turn to complete       |
| `CODEX_REQUEST_TIMEOUT_MS`  | `5000` (5 sec)     | Maximum time to wait for an app-server request response |

## Architecture

Uses the Codex app-server JSON-RPC protocol instead of CLI subprocess calls:

- **Per-connection lifecycle**: One `codex app-server` process per MCP connection, isolated between concurrent Claude sessions
- **Formal protocol**: Bidirectional JSON-RPC 2.0 with typed requests/responses and streaming notifications
- **Async-first engine**: Turns tracked in an in-memory Map with state machine and thread guards. Sync tools are thin wrappers that await completion
- **Timeout protection**: Configurable timeouts with `turn/interrupt` on expiry and a 30s cancel watchdog to prevent ghost turns
- **Clean shutdown**: On SIGINT, SIGTERM, or stdin close, already-started
  post-delivery archival gets a bounded chance to settle before the app server
  is terminated
- **Session resume**: Non-ephemeral threads are persisted by Codex. Archived
  threads are automatically unarchived when either `thread/resume` or
  `turn/start` reports archived state, using `threadId` + `cwd` when a fresh
  app-server connection must reload the thread
- **History cleanup**: Persistent threads are archived only after terminal
  result delivery; review threads are ephemeral and never enter persistent
  history
- **Thread safety**: One active turn per session enforced via thread guard. Concurrent async sessions on different threads dispatch independently
