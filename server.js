#!/usr/bin/env node

/**
 * Codex App Server MCP Wrapper
 *
 * MCP server that communicates with Codex via the app-server JSON-RPC protocol.
 * Spawns a single `codex app-server` process per MCP connection for reliable,
 * timeout-protected interaction with thread/session ID tracking.
 */

const { spawn } = require("child_process");
const path = require("path");
const readline = require("readline");

const VERSION = "2.1.1";
const TIMEOUT_MS =
  parseInt(process.env.CODEX_TIMEOUT_MS, 10) || 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000; // 5s for individual RPC requests (thread/start, etc.) — these are control-plane ops that return in milliseconds

// ---------------------------------------------------------------------------
// App Server Connection
// ---------------------------------------------------------------------------

class AppServerConnection {
  constructor() {
    this.proc = null;
    this.readline = null;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.stderr = "";
    this.turnHandlers = new Map(); // threadId -> notification handler
    this.loadedThreads = new Set(); // threads active in this connection
  }

  async connect(cwd) {
    this.proc = spawn("codex", ["app-server"], {
      cwd: cwd || process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });

    this.proc.on("error", (err) => this._handleExit(err));

    this.proc.on("exit", (code, signal) => {
      const err =
        code === 0
          ? null
          : new Error(
              `codex app-server exited (${signal || `code ${code}`})`,
            );
      this._handleExit(err);
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", (line) => this._handleLine(line));

    // Handshake
    await this.request("initialize", {
      clientInfo: {
        name: "codex-mcp-server",
        title: "Codex MCP Server",
        version: VERSION,
      },
      capabilities: {
        experimentalApi: false,
        optOutNotificationMethods: [
          "item/agentMessage/delta",
          "item/reasoning/summaryTextDelta",
          "item/reasoning/summaryPartAdded",
          "item/reasoning/textDelta",
        ],
      },
    });
    this.notify("initialized", {});
  }

  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (this.closed) {
      return Promise.reject(new Error("App server connection closed"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          pending.reject(
            new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`),
          );
        }
      }, timeoutMs);
      if (timer.unref) timer.unref();

      this.pending.set(id, {
        resolve: (val) => { clearTimeout(timer); resolve(val); },
        reject: (err) => { clearTimeout(timer); reject(err); },
        method,
      });
      this._send({ id, method, params });
    });
  }

  notify(method, params) {
    if (!this.closed) {
      this._send({ method, params });
    }
  }

  addTurnHandler(threadId, handler) {
    this.turnHandlers.set(threadId, handler);
  }

  removeTurnHandler(threadId) {
    this.turnHandlers.delete(threadId);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.readline) this.readline.close();
    if (this.proc && !this.proc.killed) {
      this.proc.stdin.end();
      const p = this.proc;
      setTimeout(() => {
        if (p.exitCode === null) p.kill("SIGTERM");
      }, 100).unref?.();
    }
  }

  _send(message) {
    if (this.proc?.stdin?.writable) {
      this.proc.stdin.write(JSON.stringify(message) + "\n");
    }
  }

  _handleLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    // Server-initiated request (e.g., approval) — reject unsupported
    if (msg.id !== undefined && msg.method) {
      this._send({
        id: msg.id,
        error: { code: -32601, message: `Unsupported: ${msg.method}` },
      });
      return;
    }

    // Response to a pending request
    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(msg.error.message || `${pending.method} failed`);
        err.data = msg.error;
        pending.reject(err);
      } else {
        pending.resolve(msg.result || {});
      }
      return;
    }

    // Notification — dispatch to the handler registered for this thread
    if (msg.method) {
      const threadId = msg.params?.threadId;
      if (threadId) {
        const handler = this.turnHandlers.get(threadId);
        if (handler) handler(msg);
      }
    }
  }

  _handleExit(error) {
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(error || new Error("App server connection closed"));
    }
    this.pending.clear();
    // Signal active turn handlers so captureTurn rejects immediately
    // instead of hanging until timeout.
    const exitError = error || new Error("App server connection closed");
    for (const handler of this.turnHandlers.values()) {
      handler({ method: "error", params: { error: { message: exitError.message } } });
    }
    this.turnHandlers.clear();
  }
}

// ---------------------------------------------------------------------------
// Connection lifecycle — one app server per MCP connection
// ---------------------------------------------------------------------------

let appServer = null;
let appServerConnecting = null; // serializes concurrent init attempts

function isAppServerHealthy(server) {
  if (!server || server.closed) return false;
  // Check if the underlying process is still running
  if (server.proc && server.proc.exitCode !== null) return false;
  return true;
}

async function getAppServer(cwd) {
  if (isAppServerHealthy(appServer)) return appServer;
  // Stale connection — close it so we don't leak
  if (appServer) {
    appServer.close();
    appServer = null;
  }
  // If another call is already connecting, wait for it instead of spawning a second
  if (appServerConnecting) return appServerConnecting;
  appServerConnecting = (async () => {
    const server = new AppServerConnection();
    try {
      await server.connect(path.resolve(cwd || process.cwd()));
      appServer = server;
      return server;
    } catch (err) {
      server.close();
      throw err;
    } finally {
      appServerConnecting = null;
    }
  })();
  return appServerConnecting;
}

// ---------------------------------------------------------------------------
// Turn capture — wait for turn/completed, collect output with timeout
// ---------------------------------------------------------------------------

function captureTurn(server, threadId, startFn, timeoutMs) {
  return new Promise((resolve, reject) => {
    let lastMessage = "";
    let reviewText = "";
    let turnId = null;
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        server.removeTurnHandler(threadId);
        // Interrupt the lingering turn so it doesn't block future calls
        if (turnId) {
          server
            .request("turn/interrupt", { threadId, turnId })
            .catch(() => {});
        }
        reject(
          new Error(`Codex timed out after ${Math.round(timeoutMs / 1000)}s`),
        );
      }
    }, timeoutMs);
    if (timer.unref) timer.unref();

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.removeTurnHandler(threadId);
      fn(value);
    };

    server.addTurnHandler(threadId, (msg) => {
      switch (msg.method) {
        case "turn/started":
          turnId = turnId || msg.params?.turn?.id;
          break;

        case "item/completed": {
          const item = msg.params?.item;
          if (item?.type === "agentMessage" && item.text) {
            lastMessage = item.text;
          }
          if (item?.type === "exitedReviewMode" && item.review) {
            reviewText = item.review;
          }
          break;
        }

        case "turn/completed": {
          const turnStatus = msg.params?.turn?.status || "completed";
          const turnError = msg.params?.turn?.error;
          if (turnStatus === "failed" && turnError) {
            settle(
              reject,
              new Error(turnError.message || "Codex turn failed"),
            );
          } else {
            settle(resolve, {
              output: reviewText || lastMessage,
              threadId,
              turnId: msg.params?.turn?.id || turnId,
              status: turnStatus,
            });
          }
          break;
        }

        case "error":
          // Transient errors (rate limits, network) — Codex will retry automatically
          if (msg.params?.willRetry) break;
          settle(
            reject,
            new Error(msg.params?.error?.message || "Codex error"),
          );
          break;
      }
    });

    // Start the turn and handle the initial response
    startFn()
      .then((response) => {
        turnId = turnId || response?.turn?.id;
        // If the turn completed immediately (e.g., error in the response)
        if (
          response?.turn?.status &&
          response.turn.status !== "inProgress"
        ) {
          const turnError = response.turn.error;
          if (response.turn.status === "failed" && turnError) {
            settle(
              reject,
              new Error(turnError.message || "Codex turn failed"),
            );
          } else {
            settle(resolve, {
              output: reviewText || lastMessage || "",
              threadId,
              turnId: response.turn.id,
              status: response.turn.status,
            });
          }
        }
      })
      .catch((err) => settle(reject, err));
  });
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function runCodexStart(args, _retried = false) {
  const cwd = path.resolve(args.cwd || process.cwd());
  const server = await getAppServer(cwd);

  let thread;
  try {
    ({ thread } = await server.request("thread/start", {
      cwd,
      sandbox: args.writable ? "workspace-write" : "read-only",
      approvalPolicy: "never",
      // ephemeral: false persists the thread to ~/.codex/sessions/ after the first
      // completed turn, enabling thread/resume by threadId+cwd in later connections.
      ephemeral: false,
    }));
  } catch (err) {
    // Stale connection — force reconnect and retry once
    if (!_retried) {
      server.close();
      appServer = null;
      return runCodexStart(args, true);
    }
    throw err;
  }

  server.loadedThreads.add(thread.id);

  const result = await captureTurn(
    server,
    thread.id,
    () =>
      server.request("turn/start", {
        threadId: thread.id,
        input: [{ type: "text", text: args.prompt }],
      }),
    TIMEOUT_MS,
  );

  return { sessionId: thread.id, output: result.output };
}

async function runCodexResume(sessionId, prompt, cwd, _retried = false) {
  cwd = path.resolve(cwd || process.cwd());
  const server = await getAppServer(cwd);

  // Threads started in this connection are already loaded — just send a new turn.
  // For threads from a previous connection, thread/resume reloads from disk.
  // Tested: thread/resume with threadId + cwd works across app-server restarts
  // as long as the thread had at least one completed turn (which persists it to
  // ~/.codex/sessions/). Without cwd the app-server cannot locate the rollout file.
  if (!server.loadedThreads.has(sessionId)) {
    try {
      // Omit sandbox so the thread keeps its original setting (read-only or writable).
      await server.request("thread/resume", {
        threadId: sessionId,
        cwd,
        approvalPolicy: "never",
      });
    } catch (err) {
      if (!_retried) {
        server.close();
        appServer = null;
        return runCodexResume(sessionId, prompt, cwd, true);
      }
      throw err;
    }
    server.loadedThreads.add(sessionId);
  }

  const result = await captureTurn(
    server,
    sessionId,
    () =>
      server.request("turn/start", {
        threadId: sessionId,
        input: [{ type: "text", text: prompt }],
      }),
    TIMEOUT_MS,
  );

  return { sessionId, output: result.output };
}

async function runCodexReview(args, _retried = false) {
  if (!args?.mode) {
    throw new Error("codex-review requires mode");
  }

  const cwd = path.resolve(args.cwd || process.cwd());
  const server = await getAppServer(cwd);

  let thread;
  try {
    ({ thread } = await server.request("thread/start", {
      cwd,
      sandbox: "read-only",
      approvalPolicy: "never",
      // Reviews are ephemeral — not persisted to disk, no session ID returned.
      // Use codex (not codex-review) if follow-up discussion is needed.
      ephemeral: true,
    }));
  } catch (err) {
    if (!_retried) {
      server.close();
      appServer = null;
      return runCodexReview(args, true);
    }
    throw err;
  }

  server.loadedThreads.add(thread.id);

  let target;
  switch (args.mode) {
    case "uncommitted":
      target = { type: "uncommittedChanges" };
      break;
    case "base":
      if (!args.base) throw new Error("mode=base requires base");
      target = { type: "baseBranch", branch: String(args.base) };
      break;
    case "commit":
      if (!args.commit) throw new Error("mode=commit requires commit");
      target = { type: "commit", sha: String(args.commit) };
      break;
    case "custom":
      if (!args.prompt?.trim()) throw new Error("mode=custom requires prompt");
      target = { type: "custom", instructions: args.prompt.trim() };
      break;
    default:
      throw new Error(`Unknown review mode: ${args.mode}`);
  }

  const result = await captureTurn(
    server,
    thread.id,
    () =>
      server.request("review/start", {
        threadId: thread.id,
        target,
        delivery: "inline",
      }),
    TIMEOUT_MS,
  );

  return { output: result.output };
}

// ---------------------------------------------------------------------------
// MCP Protocol — JSON-RPC over stdio
// ---------------------------------------------------------------------------

const mcpRl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

mcpRl.on("line", async (line) => {
  try {
    const message = JSON.parse(line);

    switch (message.method) {
      case "initialize":
        handleInitialize(message);
        break;

      case "initialized":
        break;

      case "tools/list":
        handleToolsList(message);
        break;

      case "tools/call":
        await handleToolCall(message);
        break;

      default:
        sendError(message.id, -32601, "Method not found");
    }
  } catch (e) {
    console.error("Error processing message:", e);
  }
});

function handleInitialize(message) {
  sendResponse(message.id, {
    protocolVersion: "2024-11-05",
    capabilities: {
      tools: {},
      resources: {},
    },
    serverInfo: {
      name: "codex-cli-wrapper",
      version: VERSION,
    },
    instructions:
      "IMPORTANT: Read the `collaborating-with-codex` skill before using any Codex tools. Codex is an external AI agent for second opinions on complex decisions. Form your own analysis first to avoid anchoring bias, then use Codex for brainstorming, plan validation, or code review. The `codex` tool defaults to read-only sandbox; set writable: true to allow file writes and command execution.",
  });
}

function handleToolsList(message) {
  sendResponse(message.id, {
    tools: [
      {
        name: "codex",
        description:
          "Start a new Codex session. Use like a sub-agent: be specific in prompts, provide context. Sessions can be resumed with `codex-reply` to continue the conversation.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "The prompt for Codex" },
            cwd: { type: "string", description: "Working directory" },
            writable: {
              type: "boolean",
              description:
                "Allow Codex to write files and run commands within the workspace. Defaults to false (read-only). CAUTION: When enabled, you MUST explicitly scope what Codex is and is not allowed to do in the prompt (e.g., 'run tests but do not modify any code', 'implement only in src/utils.js'). Never grant write access without clear boundaries in the prompt.",
            },
          },
          required: ["prompt"],
        },
      },
      {
        name: "codex-reply",
        description:
          "Continue an existing Codex session. Use for multi-turn discussions where prior context matters (e.g., follow-up questions, asking for review after brainstorming).",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description:
                "Session ID from a previous codex or codex-reply call",
            },
            prompt: { type: "string", description: "Follow-up prompt" },
            cwd: {
              type: "string",
              description:
                "Working directory. Required when resuming a session from a previous MCP connection — should match the cwd used when the session was created.",
            },
          },
          required: ["sessionId", "prompt"],
        },
      },
      {
        name: "codex-review",
        description:
          "Run a Codex code review on file changes (diffs, commits, uncommitted work). Reviews code quality, bugs, and correctness — not plans or architecture. For plan/architecture review, use `codex` or `codex-reply` instead. Review sessions are ephemeral and cannot be resumed.",
        inputSchema: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["uncommitted", "base", "commit", "custom"],
              description:
                "REQUIRED. One of: `uncommitted` (review staged/unstaged/untracked changes), `base` (PR-style diff — also set `base`), `commit` (single commit — also set `commit`), `custom` (free-form — also set `prompt`).",
            },
            base: {
              type: "string",
              description:
                'Branch name to diff against. Required when mode=`base`. Example: "main".',
            },
            commit: {
              type: "string",
              description: "Commit SHA to review. Required when mode=`commit`.",
            },
            prompt: {
              type: "string",
              description: "Review instructions. Required when mode=`custom`.",
            },
            cwd: {
              type: "string",
              description:
                "Working directory (repo root). If omitted, uses the server process CWD.",
            },
          },
          required: ["mode"],
        },
      },
    ],
  });
}

async function handleToolCall(message) {
  const { name, arguments: args } = message.params;

  try {
    let result;
    if (name === "codex") {
      result = await runCodexStart(args);
    } else if (name === "codex-reply") {
      result = await runCodexResume(args.sessionId, args.prompt, args.cwd);
    } else if (name === "codex-review") {
      result = await runCodexReview(args);
    } else {
      sendError(message.id, -32602, `Unknown tool: ${name}`);
      return;
    }

    const content = [{ type: "text", text: result.output }];
    if (result.sessionId) {
      content.push({
        type: "text",
        text: `\n[SESSION_ID: ${result.sessionId}]`,
      });
    }

    sendResponse(message.id, { content });
  } catch (e) {
    sendError(message.id, -32603, e.message);
  }
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC helpers
// ---------------------------------------------------------------------------

function sendResponse(id, result) {
  console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

function sendError(id, code, message) {
  console.log(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
}

// ---------------------------------------------------------------------------
// Clean shutdown
// ---------------------------------------------------------------------------

function shutdown() {
  if (appServer) appServer.close();
  process.exit();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// MCP clients typically disconnect by closing stdin, not sending signals
process.stdin.on("end", shutdown);
