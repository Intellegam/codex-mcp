#!/usr/bin/env node

/**
 * Codex App Server MCP Wrapper
 *
 * MCP server that communicates with Codex via the app-server JSON-RPC protocol.
 * Spawns a single `codex app-server` process per MCP connection for reliable,
 * timeout-protected interaction with session tracking.
 *
 * Supports synchronous and asynchronous tool calls. Async calls (async: true)
 * return a sessionId immediately; the latest turn's state is polled via
 * `codex-result` and cancelled via `codex-cancel`, both keyed by sessionId.
 */

const { spawn } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const readline = require("readline");

const VERSION = "3.2.0";
const TIMEOUT_MS =
  parseInt(process.env.CODEX_TIMEOUT_MS, 10) || 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;
const CANCEL_WATCHDOG_MS = 30_000;

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
    this.setupCount = 0; // number of in-flight setup requests (thread/start, thread/resume)
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
            new Error(
              `${method} timed out after ${Math.round(timeoutMs / 1000)}s`,
            ),
          );
        }
      }, timeoutMs);
      if (timer.unref) timer.unref();

      this.pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
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
    const exitError = error || new Error("App server connection closed");

    // Fail all turns bound to this server
    failTurnsForServer(this, exitError);

    for (const pending of this.pending.values()) {
      pending.reject(exitError);
    }
    this.pending.clear();

    for (const handler of this.turnHandlers.values()) {
      handler({
        method: "error",
        params: { error: { message: exitError.message } },
      });
    }
    this.turnHandlers.clear();
  }
}

// ---------------------------------------------------------------------------
// Connection lifecycle — one app server per MCP connection
// ---------------------------------------------------------------------------

let appServer = null;
let appServerConnecting = null;

function isAppServerHealthy(server) {
  if (!server || server.closed) return false;
  if (server.proc && server.proc.exitCode !== null) return false;
  return true;
}

async function getAppServer(cwd) {
  if (isAppServerHealthy(appServer)) return appServer;
  if (appServer) {
    appServer.close();
    appServer = null;
  }
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
// Turn & Session Engine
//
// Sessions represent Codex conversation threads. Each tool call creates a
// turn within a session. The sessionId (== Codex threadId) is the only
// user-facing identifier.
//
// Turn records track individual turns (one per codex/codex-reply/codex-review
// invocation). They are internal — Claude only interacts via sessionId.
// ---------------------------------------------------------------------------

const turns = new Map(); // turn.id -> TurnRecord (internal)
const sessions = new Map(); // sessionId -> SessionRecord (public-facing)
const activeTurnsByThread = new Map(); // threadId -> turn.id

const TERMINAL_STATES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);

function isTerminal(status) {
  return TERMINAL_STATES.has(status);
}

// --- Turn record ---

function createTurn({ toolName, cwd, timeoutMs }) {
  const id = crypto.randomUUID(); // Internal only — not exposed to Claude
  const now = Date.now();
  let resolveDone;
  const donePromise = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const turn = {
    id,
    toolName,
    status: "starting",
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    cwd,
    timeoutMs,
    threadId: null,
    sessionId: null,
    // The Codex app-server's turn ID, used for turn/interrupt.
    // Not the same as turn.id (our internal record key).
    turnId: null,
    output: "",
    lastMessage: "",
    reviewText: "",
    error: null,
    cancelRequested: false,
    cancelReason: null,
    interruptPending: false,
    interruptSent: false,
    server: null,
    donePromise,
    resolveDone,
    cleanup: null,
  };
  turns.set(id, turn);
  return turn;
}

function updateTurn(turn, patch) {
  Object.assign(turn, patch, { updatedAt: Date.now() });
  // Notify session waiters when turn state changes
  if (turn.sessionId) {
    const session = sessions.get(turn.sessionId);
    if (session) notifySessionWaiters(session);
  }
}

function settleTurn(turn, status, patch = {}) {
  if (isTerminal(turn.status)) return;
  const now = Date.now();
  Object.assign(turn, patch, {
    status,
    updatedAt: now,
    finishedAt: now,
    output:
      patch.output ?? (turn.reviewText || turn.lastMessage || turn.output || ""),
  });
  if (turn.cleanup) turn.cleanup();
  releaseThreadClaim(turn);

  // Clear active turn on session
  if (turn.sessionId) {
    const session = sessions.get(turn.sessionId);
    if (session && session.activeTurnId === turn.id) {
      session.activeTurnId = null;
      session.updatedAt = now;
    }
    if (session) notifySessionWaiters(session);
  }

  turn.resolveDone(turn);
}

function failTurn(turn, err, source) {
  settleTurn(turn, "failed", {
    error: { message: err.message || String(err), source },
  });
}

// --- Session record ---

function getOrCreateSession(sessionId, cwd) {
  let session = sessions.get(sessionId);
  if (!session) {
    const now = Date.now();
    session = {
      sessionId,
      threadId: sessionId,
      cwd: cwd || null,
      createdAt: now,
      updatedAt: now,
      latestTurnId: null,
      activeTurnId: null,
      waiters: new Set(),
    };
    sessions.set(sessionId, session);
  }
  if (cwd) session.cwd = cwd;
  return session;
}

function attachTurnToSession(session, turn) {
  session.latestTurnId = turn.id;
  session.activeTurnId = turn.id;
  session.updatedAt = Date.now();
  notifySessionWaiters(session);
}

function snapshotSession(session) {
  const turn = turns.get(session.latestTurnId);
  if (!turn) {
    return {
      sessionId: session.sessionId,
      status: "unknown",
      done: false,
      error: { message: "No turn found for session", source: "internal" },
    };
  }
  return {
    sessionId: session.sessionId,
    toolName: turn.toolName,
    status: turn.status,
    done: isTerminal(turn.status),
    createdAt: new Date(turn.createdAt).toISOString(),
    finishedAt: turn.finishedAt
      ? new Date(turn.finishedAt).toISOString()
      : null,
    elapsed: turn.finishedAt
      ? `${Math.round((turn.finishedAt - turn.createdAt) / 1000)}s`
      : `${Math.round((Date.now() - turn.createdAt) / 1000)}s (running)`,
    cancelRequested: turn.cancelRequested,
    output: turn.output || "",
    error: turn.error,
  };
}

// --- Thread guard ---

function claimThread(threadId, turn) {
  const existingId = activeTurnsByThread.get(threadId);
  if (existingId) {
    const existing = turns.get(existingId);
    if (existing && !isTerminal(existing.status)) {
      throw new Error(
        `Session ${threadId} already has an active turn (${existing.status})`,
      );
    }
  }
  activeTurnsByThread.set(threadId, turn.id);
}

function releaseThreadClaim(turn) {
  if (turn.threadId && activeTurnsByThread.get(turn.threadId) === turn.id) {
    activeTurnsByThread.delete(turn.threadId);
  }
}

// --- Cancel ---

function requestTurnCancel(turn, reason = "user") {
  if (isTerminal(turn.status)) return turn;

  if (!turn.cancelRequested) {
    turn.cancelRequested = true;
    turn.cancelReason = reason;
  }

  // Always transition to cancelling — even if turnId isn't known yet.
  // We keep the handler and thread claim alive until the start response
  // arrives (which gives us the turnId to interrupt) or the turn settles.
  if (turn.status !== "cancelling") updateTurn(turn, { status: "cancelling" });

  if (turn.turnId) {
    maybeSendInterrupt(turn);
  } else {
    turn.interruptPending = true;
  }

  return turn;
}

function maybeSendInterrupt(turn) {
  if (turn.interruptSent || !turn.turnId || !turn.server || turn.server.closed)
    return;
  turn.interruptPending = false;
  turn.interruptSent = true;
  turn.server
    .request("turn/interrupt", {
      threadId: turn.threadId,
      turnId: turn.turnId,
    })
    .catch(() => {});

  // Watchdog: if the turn doesn't complete after interrupt, force-settle
  const watchdog = setTimeout(() => {
    if (!isTerminal(turn.status)) {
      const terminalStatus =
        turn.cancelReason === "timeout" ? "timed_out" : "cancelled";
      settleTurn(turn, terminalStatus, {
        error: {
          message: `Codex did not respond to interrupt within ${CANCEL_WATCHDOG_MS / 1000}s`,
          source: turn.cancelReason === "timeout" ? "timeout" : "cancel",
        },
      });
    }
  }, CANCEL_WATCHDOG_MS);
  if (watchdog.unref) watchdog.unref();
}

// --- Turn capture (background) ---

function runTurnCapture(turn, server, threadId, startFn) {
  const timer = setTimeout(
    () => requestTurnCancel(turn, "timeout"),
    turn.timeoutMs,
  );
  if (timer.unref) timer.unref();

  turn.server = server;

  const cleanup = () => {
    clearTimeout(timer);
    server.removeTurnHandler(threadId);
    releaseThreadClaim(turn);
    turn.cleanup = null;
  };
  turn.cleanup = cleanup;

  server.addTurnHandler(threadId, (msg) => handleTurnNotification(turn, msg));

  startFn()
    .then((response) => handleStartResponse(turn, response))
    .catch((err) => failTurn(turn, err, "turn"));
}

function handleStartResponse(turn, response) {
  if (isTerminal(turn.status)) return;

  const appTurnId = response?.turn?.id;
  if (appTurnId) {
    turn.turnId = turn.turnId || appTurnId;
    if (turn.interruptPending) maybeSendInterrupt(turn);
  }

  // Check for immediately terminal turns
  if (response?.turn?.status && response.turn.status !== "inProgress") {
    const turnError = response.turn.error;
    if (response.turn.status === "failed" && turnError) {
      failTurn(
        turn,
        new Error(turnError.message || "Codex turn failed"),
        "turn",
      );
    } else {
      settleTurn(turn, "succeeded");
    }
    return;
  }

  if (turn.status === "starting") {
    updateTurn(turn, { status: "running" });
  }
}

function handleTurnNotification(turn, msg) {
  if (isTerminal(turn.status)) return;

  switch (msg.method) {
    case "turn/started":
      turn.turnId = turn.turnId || msg.params?.turn?.id;
      if (turn.interruptPending) maybeSendInterrupt(turn);
      if (turn.status === "starting") updateTurn(turn, { status: "running" });
      break;

    case "item/completed": {
      const item = msg.params?.item;
      if (item?.type === "agentMessage" && item.text) {
        turn.lastMessage = item.text;
      }
      if (item?.type === "exitedReviewMode" && item.review) {
        turn.reviewText = item.review;
      }
      break;
    }

    case "turn/completed": {
      const turnStatus = msg.params?.turn?.status || "completed";
      const turnError = msg.params?.turn?.error;
      if (turnStatus === "failed" && turnError) {
        failTurn(
          turn,
          new Error(turnError.message || "Codex turn failed"),
          "turn",
        );
      } else if (turn.cancelRequested && turn.interruptSent) {
        // Interrupt was sent — treat completion as cancel/timeout
        settleTurn(
          turn,
          turn.cancelReason === "timeout" ? "timed_out" : "cancelled",
          {
            error:
              turn.cancelReason === "timeout"
                ? {
                    message: `Codex timed out after ${Math.round(turn.timeoutMs / 1000)}s`,
                    source: "timeout",
                  }
                : null,
          },
        );
      } else {
        // Turn completed normally (even if cancel requested but not yet sent)
        settleTurn(turn, "succeeded");
      }
      break;
    }

    case "error":
      if (msg.params?.willRetry) break;
      failTurn(
        turn,
        new Error(msg.params?.error?.message || "Codex error"),
        "turn",
      );
      break;
  }
}

// --- Session waiter support (long-poll for codex-result) ---

function notifySessionWaiters(session) {
  // Copy and clear before calling — waiters may re-add themselves
  const waiters = [...session.waiters];
  session.waiters.clear();
  for (const waiter of waiters) {
    waiter();
  }
}

function waitForSessionDone(session) {
  return new Promise((resolve) => {
    const turn = turns.get(session.latestTurnId);
    if (!turn || isTerminal(turn.status)) {
      resolve();
      return;
    }
    const waiter = () => {
      // Only resolve when the turn is terminal — ignore intermediate state changes
      const t = turns.get(session.latestTurnId);
      if (!t || isTerminal(t.status)) {
        resolve();
      } else {
        session.waiters.add(waiter);
      }
    };
    session.waiters.add(waiter);
  });
}

// --- App server exit hook ---

function failTurnsForServer(server, error) {
  for (const turn of turns.values()) {
    if (turn.server !== server) continue;
    if (isTerminal(turn.status)) continue;
    failTurn(turn, error, "app-server");
  }
}

function hasActiveTurnsOnServer(server) {
  if (server.setupCount > 0) return true;
  for (const turn of turns.values()) {
    if (turn.server !== server) continue;
    if (!isTerminal(turn.status)) return true;
  }
  return false;
}

// Retry server connection only if no other turns are using it
function retryableServerClose(server) {
  if (hasActiveTurnsOnServer(server)) return false;
  server.close();
  appServer = null;
  return true;
}

// ---------------------------------------------------------------------------
// Turn submissions
// ---------------------------------------------------------------------------

async function submitCodexStart(args) {
  const cwd = path.resolve(args.cwd || process.cwd());
  const turn = createTurn({ toolName: "codex", cwd, timeoutMs: TIMEOUT_MS });

  let server;
  try {
    server = await getAppServer(cwd);
  } catch (err) {
    failTurn(turn, err, "setup");
    return turn;
  }

  const threadStartParams = {
    cwd,
    sandbox: args.writable ? "workspace-write" : "read-only",
    approvalPolicy: "never",
    ephemeral: false,
  };

  let thread;
  server.setupCount++;
  try {
    ({ thread } = await server.request("thread/start", threadStartParams));
  } catch (err) {
    server.setupCount--;
    if (!retryableServerClose(server)) {
      failTurn(turn, err, "setup");
      return turn;
    }
    server = await getAppServer(cwd).catch(() => null);
    if (!server) {
      failTurn(turn, err, "setup");
      return turn;
    }
    server.setupCount++;
    try {
      ({ thread } = await server.request("thread/start", threadStartParams));
    } catch (retryErr) {
      server.setupCount--;
      failTurn(turn, retryErr, "setup");
      return turn;
    }
  }
  server.setupCount--;

  server.loadedThreads.add(thread.id);
  turn.threadId = thread.id;
  turn.sessionId = thread.id;

  // Create session and attach turn synchronously before any async work
  const session = getOrCreateSession(thread.id, cwd);
  attachTurnToSession(session, turn);

  try {
    claimThread(thread.id, turn);
  } catch (err) {
    failTurn(turn, err, "setup");
    return turn;
  }

  runTurnCapture(turn, server, thread.id, () =>
    server.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: args.prompt }],
    }),
  );

  return turn;
}

async function submitCodexResume(args) {
  const sessionId = args.sessionId;
  const prompt = args.prompt;
  const cwd = path.resolve(args.cwd || process.cwd());
  const turn = createTurn({
    toolName: "codex-reply",
    cwd,
    timeoutMs: TIMEOUT_MS,
  });
  turn.threadId = sessionId;
  turn.sessionId = sessionId;

  let server;
  try {
    server = await getAppServer(cwd);
  } catch (err) {
    failTurn(turn, err, "setup");
    return turn;
  }

  if (!server.loadedThreads.has(sessionId)) {
    server.setupCount++;
    try {
      await server.request("thread/resume", {
        threadId: sessionId,
        cwd,
        approvalPolicy: "never",
      });
    } catch (err) {
      server.setupCount--;
      if (!retryableServerClose(server)) {
        failTurn(turn, err, "setup");
        return turn;
      }
      server = await getAppServer(cwd).catch(() => null);
      if (!server) {
        failTurn(turn, err, "setup");
        return turn;
      }
      server.setupCount++;
      try {
        await server.request("thread/resume", {
          threadId: sessionId,
          cwd,
          approvalPolicy: "never",
        });
      } catch (retryErr) {
        server.setupCount--;
        failTurn(turn, retryErr, "setup");
        return turn;
      }
    }
    server.setupCount--;
    server.loadedThreads.add(sessionId);
  }

  try {
    claimThread(sessionId, turn);
  } catch (err) {
    failTurn(turn, err, "setup");
    return turn;
  }

  // Create/get session and attach turn AFTER claimThread succeeds.
  // Creating earlier would leave a stale session record on failed resume.
  // Attaching earlier would overwrite the session's latestTurnId, making
  // the real running turn unobservable if this setup fails.
  const session = getOrCreateSession(sessionId, cwd);
  attachTurnToSession(session, turn);

  runTurnCapture(turn, server, sessionId, () =>
    server.request("turn/start", {
      threadId: sessionId,
      input: [{ type: "text", text: prompt }],
    }),
  );

  return turn;
}

async function submitCodexReview(args) {
  const cwd = path.resolve(args.cwd || process.cwd());
  const turn = createTurn({
    toolName: "codex-review",
    cwd,
    timeoutMs: TIMEOUT_MS,
  });

  if (!args?.mode) {
    failTurn(turn, new Error("codex-review requires mode"), "setup");
    return turn;
  }

  // Validate review args before creating any threads
  let target;
  try {
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
        if (!args.prompt?.trim())
          throw new Error("mode=custom requires prompt");
        target = { type: "custom", instructions: args.prompt.trim() };
        break;
      default:
        throw new Error(`Unknown review mode: ${args.mode}`);
    }
  } catch (err) {
    failTurn(turn, err, "setup");
    return turn;
  }

  let server;
  try {
    server = await getAppServer(cwd);
  } catch (err) {
    failTurn(turn, err, "setup");
    return turn;
  }

  const threadStartParams = {
    cwd,
    sandbox: "read-only",
    approvalPolicy: "never",
    ephemeral: false,
  };

  let thread;
  server.setupCount++;
  try {
    ({ thread } = await server.request("thread/start", threadStartParams));
  } catch (err) {
    server.setupCount--;
    if (!retryableServerClose(server)) {
      failTurn(turn, err, "setup");
      return turn;
    }
    server = await getAppServer(cwd).catch(() => null);
    if (!server) {
      failTurn(turn, err, "setup");
      return turn;
    }
    server.setupCount++;
    try {
      ({ thread } = await server.request("thread/start", threadStartParams));
    } catch (retryErr) {
      server.setupCount--;
      failTurn(turn, retryErr, "setup");
      return turn;
    }
  }
  server.setupCount--;

  server.loadedThreads.add(thread.id);
  turn.threadId = thread.id;
  turn.sessionId = thread.id;

  // Create session and attach turn synchronously
  const session = getOrCreateSession(thread.id, cwd);
  attachTurnToSession(session, turn);

  try {
    claimThread(thread.id, turn);
  } catch (err) {
    failTurn(turn, err, "setup");
    return turn;
  }

  runTurnCapture(turn, server, thread.id, () =>
    server.request("review/start", {
      threadId: thread.id,
      target,
      delivery: "inline",
    }),
  );

  return turn;
}

// ---------------------------------------------------------------------------
// Sync wrappers (preserve existing API for non-async calls)
// ---------------------------------------------------------------------------

async function runCodexStart(args) {
  const turn = await submitCodexStart(args);
  if (!isTerminal(turn.status)) await turn.donePromise;
  if (turn.status !== "succeeded") {
    throw new Error(turn.error?.message || `Codex ${turn.status}`);
  }
  return { sessionId: turn.sessionId, output: turn.output };
}

async function runCodexResume(args) {
  const turn = await submitCodexResume(args);
  if (!isTerminal(turn.status)) await turn.donePromise;
  if (turn.status !== "succeeded") {
    throw new Error(turn.error?.message || `Codex ${turn.status}`);
  }
  return { sessionId: turn.sessionId, output: turn.output };
}

async function runCodexReview(args) {
  const turn = await submitCodexReview(args);
  if (!isTerminal(turn.status)) await turn.donePromise;
  if (turn.status !== "succeeded") {
    throw new Error(turn.error?.message || `Codex ${turn.status}`);
  }
  return { sessionId: turn.sessionId, output: turn.output };
}

// ---------------------------------------------------------------------------
// Async tool implementations
// ---------------------------------------------------------------------------

async function runCodexResult({ sessionId, wait = false }) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Unknown sessionId");

  if (wait) {
    await waitForSessionDone(session);
  }

  return snapshotSession(session);
}

function runCodexCancel({ sessionId }) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Unknown sessionId");

  // Cancel the active turn if there is one
  if (session.activeTurnId) {
    const turn = turns.get(session.activeTurnId);
    if (turn && !isTerminal(turn.status)) {
      requestTurnCancel(turn, "user");
    }
  }

  return snapshotSession(session);
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
            async: {
              type: "boolean",
              description:
                "Run asynchronously. Returns a sessionId immediately instead of blocking. Use `codex-result` to poll the latest turn state and `codex-cancel` to cancel. Multiple async sessions can run at the same time. Use when you have other work to do in parallel — if you would just poll in a loop, use sync (the default) instead.",
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
                "Session ID from a previous codex, codex-reply, or codex-review call",
            },
            prompt: { type: "string", description: "Follow-up prompt" },
            cwd: {
              type: "string",
              description:
                "Working directory. Required when resuming a session from a previous MCP connection — should match the cwd used when the session was created.",
            },
            async: {
              type: "boolean",
              description:
                "Run asynchronously. Returns the same sessionId immediately. Use `codex-result` to poll the latest turn state and `codex-cancel` to cancel.",
            },
          },
          required: ["sessionId", "prompt"],
        },
      },
      {
        name: "codex-review",
        description:
          "Run a Codex code review on file changes (diffs, commits, uncommitted work). Reviews code quality, bugs, and correctness — not plans or architecture. For plan/architecture review, use `codex` or `codex-reply` instead. Review sessions return a sessionId and can be continued with `codex-reply`.",
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
              description:
                "Commit SHA to review. Required when mode=`commit`.",
            },
            prompt: {
              type: "string",
              description:
                "Review instructions. Required when mode=`custom`.",
            },
            cwd: {
              type: "string",
              description:
                "Working directory (repo root). If omitted, uses the server process CWD.",
            },
            async: {
              type: "boolean",
              description:
                "Run asynchronously. Returns a new sessionId immediately. Use `codex-result` to poll the review turn and `codex-cancel` to cancel.",
            },
          },
          required: ["mode"],
        },
      },
      {
        name: "codex-result",
        description:
          "Get the latest turn status or result for a Codex session. Works for any session started by codex, codex-reply, or codex-review.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description: "Session ID to check",
            },
            wait: {
              type: "boolean",
              description:
                "If true, blocks until the latest turn completes. If false or omitted, returns the current state immediately.",
            },
          },
          required: ["sessionId"],
        },
      },
      {
        name: "codex-cancel",
        description:
          "Cancel the active turn on a Codex session. If a turn is still in progress, requests cancellation. If no active turn or already completed, returns the current state unchanged.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description: "Session ID whose active turn should be cancelled",
            },
          },
          required: ["sessionId"],
        },
      },
    ],
  });
}

async function handleToolCall(message) {
  const { name, arguments: args } = message.params;

  try {
    // --- Async submissions ---
    if (
      (name === "codex" ||
        name === "codex-reply" ||
        name === "codex-review") &&
      args.async
    ) {
      let turn;
      if (name === "codex") {
        turn = await submitCodexStart(args);
      } else if (name === "codex-reply") {
        turn = await submitCodexResume(args);
      } else {
        turn = await submitCodexReview(args);
      }
      // If the turn failed before being attached to a session (e.g., thread
      // guard rejection), show the turn's error directly. Otherwise show the
      // session's latest turn state.
      const session = sessions.get(turn.sessionId);
      const isAttached = session && session.latestTurnId === turn.id;
      const snapshot =
        isTerminal(turn.status) && !isAttached
          ? snapshotFallback(turn)
          : session
            ? snapshotSession(session)
            : snapshotFallback(turn);
      sendResponse(message.id, {
        content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }],
      });
      return;
    }

    // --- Session tools ---
    if (name === "codex-result") {
      const snapshot = await runCodexResult(args);
      sendResponse(message.id, {
        content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }],
      });
      return;
    }

    if (name === "codex-cancel") {
      const snapshot = runCodexCancel(args);
      sendResponse(message.id, {
        content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }],
      });
      return;
    }

    // --- Sync tool calls (existing behavior) ---
    let result;
    if (name === "codex") {
      result = await runCodexStart(args);
    } else if (name === "codex-reply") {
      result = await runCodexResume(args);
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

// Fallback snapshot when turn failed before session was created
function snapshotFallback(turn) {
  return {
    sessionId: turn.sessionId,
    toolName: turn.toolName,
    status: turn.status,
    done: isTerminal(turn.status),
    createdAt: new Date(turn.createdAt).toISOString(),
    finishedAt: turn.finishedAt
      ? new Date(turn.finishedAt).toISOString()
      : null,
    elapsed: turn.finishedAt
      ? `${Math.round((turn.finishedAt - turn.createdAt) / 1000)}s`
      : `${Math.round((Date.now() - turn.createdAt) / 1000)}s (running)`,
    cancelRequested: turn.cancelRequested,
    output: turn.output || "",
    error: turn.error,
  };
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC helpers
// ---------------------------------------------------------------------------

function sendResponse(id, result) {
  console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

function sendError(id, code, message) {
  console.log(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }),
  );
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
process.stdin.on("end", shutdown);
