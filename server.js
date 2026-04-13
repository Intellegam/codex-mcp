#!/usr/bin/env node

/**
 * Codex App Server MCP Wrapper
 *
 * MCP server that communicates with Codex via the app-server JSON-RPC protocol.
 * Spawns a single `codex app-server` process per MCP connection for reliable,
 * timeout-protected interaction with thread/session ID tracking.
 *
 * Supports synchronous and asynchronous tool calls. Async calls (async: true)
 * return a jobId immediately; results are polled via `codex-result` and
 * cancelled via `codex-cancel`.
 */

const { spawn } = require("child_process");
const path = require("path");
const readline = require("readline");

const VERSION = "3.0.0";
const TIMEOUT_MS =
  parseInt(process.env.CODEX_TIMEOUT_MS, 10) || 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;
const JOB_TTL_MS =
  parseInt(process.env.CODEX_JOB_TTL_MS, 10) || 60 * 60 * 1000;
const JOB_RESULT_WAIT_MAX_MS = 30_000;

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

    // Fail all jobs bound to this server (belt-and-suspenders with turn handler path)
    failJobsForServer(this, exitError);

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
// Job Engine
// ---------------------------------------------------------------------------

const jobs = new Map();
const activeJobsByThread = new Map();
let nextJobId = 0;
let evictionTimer = null;

const TERMINAL_STATES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);

function isTerminal(status) {
  return TERMINAL_STATES.has(status);
}

function createJob({ toolName, cwd, timeoutMs }) {
  const id = `job-${++nextJobId}`;
  const now = Date.now();
  let resolveDone;
  const donePromise = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const job = {
    id,
    toolName,
    status: "starting",
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    expiresAt: null,
    cwd,
    timeoutMs,
    threadId: null,
    sessionId: null,
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
    waiters: new Set(),
    donePromise,
    resolveDone,
    cleanup: null,
  };
  jobs.set(id, job);
  return job;
}

function updateJob(job, patch) {
  Object.assign(job, patch, { updatedAt: Date.now() });
  notifyJobWaiters(job);
}

function settleJob(job, status, patch = {}) {
  if (isTerminal(job.status)) return;
  const now = Date.now();
  Object.assign(job, patch, {
    status,
    updatedAt: now,
    finishedAt: now,
    expiresAt: now + JOB_TTL_MS,
    output:
      patch.output ?? (job.reviewText || job.lastMessage || job.output || ""),
  });
  if (job.cleanup) job.cleanup();
  releaseThreadClaim(job); // Safety net — cleanup usually handles this
  notifyJobWaiters(job);
  job.resolveDone(job);
  scheduleEvictionSweep();
}

function failJob(job, err, source) {
  settleJob(job, "failed", {
    error: { message: err.message || String(err), source },
  });
}

function snapshotJob(job) {
  return {
    jobId: job.id,
    toolName: job.toolName,
    status: job.status,
    done: isTerminal(job.status),
    createdAt: new Date(job.createdAt).toISOString(),
    finishedAt: job.finishedAt
      ? new Date(job.finishedAt).toISOString()
      : null,
    expiresAt: job.expiresAt ? new Date(job.expiresAt).toISOString() : null,
    elapsed: job.finishedAt
      ? `${Math.round((job.finishedAt - job.createdAt) / 1000)}s`
      : `${Math.round((Date.now() - job.createdAt) / 1000)}s (running)`,
    sessionId: job.sessionId,
    threadId: job.threadId,
    cancelRequested: job.cancelRequested,
    output: job.output || "",
    error: job.error,
  };
}

// --- Thread guard ---

function claimThread(threadId, job) {
  const existingId = activeJobsByThread.get(threadId);
  if (existingId) {
    const existing = jobs.get(existingId);
    if (existing && !isTerminal(existing.status)) {
      throw new Error(
        `Thread ${threadId} already has active job ${existing.id} (${existing.status})`,
      );
    }
  }
  activeJobsByThread.set(threadId, job.id);
}

function releaseThreadClaim(job) {
  if (job.threadId && activeJobsByThread.get(job.threadId) === job.id) {
    activeJobsByThread.delete(job.threadId);
  }
}

// --- Cancel ---

function requestJobCancel(job, reason = "user") {
  if (isTerminal(job.status)) return job;

  if (!job.cancelRequested) {
    job.cancelRequested = true;
    job.cancelReason = reason;
  }

  // Always transition to cancelling — even if turnId isn't known yet.
  // We keep the handler and thread claim alive until the start response
  // arrives (which gives us the turnId to interrupt) or the turn settles.
  if (job.status !== "cancelling") updateJob(job, { status: "cancelling" });

  if (job.turnId) {
    maybeSendInterrupt(job);
  } else {
    job.interruptPending = true;
  }

  return job;
}

const CANCEL_WATCHDOG_MS = 30_000; // Force-fail if cancelling doesn't settle within 30s

function maybeSendInterrupt(job) {
  if (job.interruptSent || !job.turnId || !job.server || job.server.closed)
    return;
  job.interruptPending = false;
  job.interruptSent = true;
  job.server
    .request("turn/interrupt", { threadId: job.threadId, turnId: job.turnId })
    .catch(() => {});

  // Watchdog: if the turn doesn't complete after interrupt, force-settle
  const watchdog = setTimeout(() => {
    if (!isTerminal(job.status)) {
      const terminalStatus =
        job.cancelReason === "timeout" ? "timed_out" : "cancelled";
      settleJob(job, terminalStatus, {
        error: {
          message: `Codex did not respond to interrupt within ${CANCEL_WATCHDOG_MS / 1000}s`,
          source: job.cancelReason === "timeout" ? "timeout" : "cancel",
        },
      });
    }
  }, CANCEL_WATCHDOG_MS);
  if (watchdog.unref) watchdog.unref();
}

// --- Turn capture (background) ---

function runTurnCapture(job, server, threadId, startFn) {
  const timer = setTimeout(
    () => requestJobCancel(job, "timeout"),
    job.timeoutMs,
  );
  if (timer.unref) timer.unref();

  job.server = server;

  const cleanup = () => {
    clearTimeout(timer);
    server.removeTurnHandler(threadId);
    releaseThreadClaim(job);
    job.cleanup = null;
  };
  job.cleanup = cleanup;

  server.addTurnHandler(threadId, (msg) => handleTurnNotification(job, msg));

  startFn()
    .then((response) => handleStartResponse(job, response))
    .catch((err) => failJob(job, err, "turn"));
}

function handleStartResponse(job, response) {
  if (isTerminal(job.status)) return;

  const turnId = response?.turn?.id;
  if (turnId) {
    job.turnId = job.turnId || turnId;
    if (job.interruptPending) maybeSendInterrupt(job);
  }

  // Check for immediately terminal turns
  if (response?.turn?.status && response.turn.status !== "inProgress") {
    const turnError = response.turn.error;
    if (response.turn.status === "failed" && turnError) {
      failJob(job, new Error(turnError.message || "Codex turn failed"), "turn");
    } else {
      settleJob(job, "succeeded");
    }
    return;
  }

  if (job.status === "starting") {
    updateJob(job, { status: "running" });
  }
}

function handleTurnNotification(job, msg) {
  if (isTerminal(job.status)) return;

  switch (msg.method) {
    case "turn/started":
      job.turnId = job.turnId || msg.params?.turn?.id;
      if (job.interruptPending) maybeSendInterrupt(job);
      if (job.status === "starting") updateJob(job, { status: "running" });
      break;

    case "item/completed": {
      const item = msg.params?.item;
      if (item?.type === "agentMessage" && item.text) {
        job.lastMessage = item.text;
      }
      if (item?.type === "exitedReviewMode" && item.review) {
        job.reviewText = item.review;
      }
      break;
    }

    case "turn/completed": {
      const turnStatus = msg.params?.turn?.status || "completed";
      const turnError = msg.params?.turn?.error;
      if (turnStatus === "failed" && turnError) {
        failJob(
          job,
          new Error(turnError.message || "Codex turn failed"),
          "turn",
        );
      } else if (job.cancelRequested && job.interruptSent) {
        // Interrupt was sent — treat completion as cancel/timeout
        settleJob(
          job,
          job.cancelReason === "timeout" ? "timed_out" : "cancelled",
          {
            error:
              job.cancelReason === "timeout"
                ? {
                    message: `Codex timed out after ${Math.round(job.timeoutMs / 1000)}s`,
                    source: "timeout",
                  }
                : null,
          },
        );
      } else {
        // Turn completed normally (even if cancel requested but not yet sent)
        settleJob(job, "succeeded");
      }
      break;
    }

    case "error":
      if (msg.params?.willRetry) break;
      failJob(
        job,
        new Error(msg.params?.error?.message || "Codex error"),
        "turn",
      );
      break;
  }
}

// --- Waiter support (long-poll for codex-result) ---

function notifyJobWaiters(job) {
  for (const waiter of job.waiters) {
    waiter();
  }
  job.waiters.clear();
}

function waitForJobChange(job, waitMs) {
  return new Promise((resolve) => {
    if (isTerminal(job.status) || waitMs <= 0) {
      resolve();
      return;
    }
    const cappedMs = Math.min(waitMs, JOB_RESULT_WAIT_MAX_MS);
    const timer = setTimeout(() => {
      job.waiters.delete(waiter);
      resolve();
    }, cappedMs);
    if (timer.unref) timer.unref();
    const waiter = () => {
      clearTimeout(timer);
      resolve();
    };
    job.waiters.add(waiter);
  });
}

// --- Eviction ---

function scheduleEvictionSweep() {
  if (evictionTimer) clearTimeout(evictionTimer);
  const now = Date.now();
  let nextExpiresAt = Infinity;

  for (const [id, job] of jobs) {
    if (job.expiresAt && job.expiresAt <= now) {
      jobs.delete(id);
      continue;
    }
    if (job.expiresAt && job.expiresAt < nextExpiresAt) {
      nextExpiresAt = job.expiresAt;
    }
  }

  if (Number.isFinite(nextExpiresAt)) {
    evictionTimer = setTimeout(
      scheduleEvictionSweep,
      Math.max(1000, nextExpiresAt - now),
    );
    if (evictionTimer.unref) evictionTimer.unref();
  } else {
    evictionTimer = null;
  }
}

// --- App server exit hook ---

function failJobsForServer(server, error) {
  for (const job of jobs.values()) {
    if (job.server !== server) continue;
    if (isTerminal(job.status)) continue;
    failJob(job, error, "app-server");
  }
}

function hasActiveJobsOnServer(server) {
  if (server.setupCount > 0) return true;
  for (const job of jobs.values()) {
    if (job.server !== server) continue;
    if (!isTerminal(job.status)) return true;
  }
  return false;
}

// Retry server connection only if no other jobs are using it
function retryableServerClose(server) {
  if (hasActiveJobsOnServer(server)) return false;
  server.close();
  appServer = null;
  return true;
}

// ---------------------------------------------------------------------------
// Job submissions
// ---------------------------------------------------------------------------

async function submitCodexStartJob(args) {
  const cwd = path.resolve(args.cwd || process.cwd());
  const job = createJob({ toolName: "codex", cwd, timeoutMs: TIMEOUT_MS });

  let server;
  try {
    server = await getAppServer(cwd);
  } catch (err) {
    failJob(job, err, "setup");
    return job;
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
    // Retry once with fresh connection if no other jobs are using it
    if (!retryableServerClose(server)) {
      failJob(job, err, "setup");
      return job;
    }
    server = await getAppServer(cwd).catch((e) => null);
    if (!server) {
      failJob(job, err, "setup");
      return job;
    }
    server.setupCount++;
    try {
      ({ thread } = await server.request("thread/start", threadStartParams));
    } catch (retryErr) {
      server.setupCount--;
      failJob(job, retryErr, "setup");
      return job;
    }
  }
  server.setupCount--;

  server.loadedThreads.add(thread.id);
  job.threadId = thread.id;
  job.sessionId = thread.id;

  try {
    claimThread(thread.id, job);
  } catch (err) {
    failJob(job, err, "setup");
    return job;
  }

  runTurnCapture(job, server, thread.id, () =>
    server.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: args.prompt }],
    }),
  );

  return job;
}

async function submitCodexResumeJob(args) {
  const sessionId = args.sessionId;
  const prompt = args.prompt;
  const cwd = path.resolve(args.cwd || process.cwd());
  const job = createJob({
    toolName: "codex-reply",
    cwd,
    timeoutMs: TIMEOUT_MS,
  });
  job.threadId = sessionId;
  job.sessionId = sessionId;

  let server;
  try {
    server = await getAppServer(cwd);
  } catch (err) {
    failJob(job, err, "setup");
    return job;
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
        failJob(job, err, "setup");
        return job;
      }
      server = await getAppServer(cwd).catch(() => null);
      if (!server) {
        failJob(job, err, "setup");
        return job;
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
        failJob(job, retryErr, "setup");
        return job;
      }
    }
    server.setupCount--;
    server.loadedThreads.add(sessionId);
  }

  try {
    claimThread(sessionId, job);
  } catch (err) {
    failJob(job, err, "setup");
    return job;
  }

  runTurnCapture(job, server, sessionId, () =>
    server.request("turn/start", {
      threadId: sessionId,
      input: [{ type: "text", text: prompt }],
    }),
  );

  return job;
}

async function submitCodexReviewJob(args) {
  const cwd = path.resolve(args.cwd || process.cwd());
  const job = createJob({
    toolName: "codex-review",
    cwd,
    timeoutMs: TIMEOUT_MS,
  });

  if (!args?.mode) {
    failJob(job, new Error("codex-review requires mode"), "setup");
    return job;
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
    failJob(job, err, "setup");
    return job;
  }

  let server;
  try {
    server = await getAppServer(cwd);
  } catch (err) {
    failJob(job, err, "setup");
    return job;
  }

  const threadStartParams = {
    cwd,
    sandbox: "read-only",
    approvalPolicy: "never",
    ephemeral: true,
  };

  let thread;
  server.setupCount++;
  try {
    ({ thread } = await server.request("thread/start", threadStartParams));
  } catch (err) {
    server.setupCount--;
    if (!retryableServerClose(server)) {
      failJob(job, err, "setup");
      return job;
    }
    server = await getAppServer(cwd).catch(() => null);
    if (!server) {
      failJob(job, err, "setup");
      return job;
    }
    server.setupCount++;
    try {
      ({ thread } = await server.request("thread/start", threadStartParams));
    } catch (retryErr) {
      server.setupCount--;
      failJob(job, retryErr, "setup");
      return job;
    }
  }
  server.setupCount--;

  server.loadedThreads.add(thread.id);
  job.threadId = thread.id;
  // Reviews are ephemeral — no sessionId

  try {
    claimThread(thread.id, job);
  } catch (err) {
    failJob(job, err, "setup");
    return job;
  }

  runTurnCapture(job, server, thread.id, () =>
    server.request("review/start", {
      threadId: thread.id,
      target,
      delivery: "inline",
    }),
  );

  return job;
}

// ---------------------------------------------------------------------------
// Sync wrappers (preserve existing API for non-async calls)
// ---------------------------------------------------------------------------

async function runCodexStart(args) {
  const job = await submitCodexStartJob(args);
  if (!isTerminal(job.status)) await job.donePromise;
  jobs.delete(job.id); // Sync jobs are not pollable — evict immediately
  if (job.status !== "succeeded") {
    throw new Error(job.error?.message || `Codex ${job.status}`);
  }
  return { sessionId: job.sessionId, output: job.output };
}

async function runCodexResume(args) {
  const job = await submitCodexResumeJob(args);
  if (!isTerminal(job.status)) await job.donePromise;
  jobs.delete(job.id);
  if (job.status !== "succeeded") {
    throw new Error(job.error?.message || `Codex ${job.status}`);
  }
  return { sessionId: job.sessionId, output: job.output };
}

async function runCodexReview(args) {
  const job = await submitCodexReviewJob(args);
  if (!isTerminal(job.status)) await job.donePromise;
  jobs.delete(job.id);
  if (job.status !== "succeeded") {
    throw new Error(job.error?.message || `Codex ${job.status}`);
  }
  return { output: job.output };
}

// ---------------------------------------------------------------------------
// Async tool implementations
// ---------------------------------------------------------------------------

async function runCodexResult({ jobId, waitMs = 0 }) {
  const job = jobs.get(jobId);
  if (!job) throw new Error("Unknown or expired jobId");

  if (!isTerminal(job.status) && waitMs > 0) {
    await waitForJobChange(job, waitMs);
  }

  return snapshotJob(job);
}

function runCodexCancel({ jobId }) {
  const job = jobs.get(jobId);
  if (!job) throw new Error("Unknown or expired jobId");

  requestJobCancel(job, "user");
  return snapshotJob(job);
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
                "Run asynchronously. Returns a jobId immediately instead of blocking. Use `codex-result` to poll for the result and `codex-cancel` to cancel. Use when you have other work to do in parallel — if you would just poll in a loop, use sync (the default) instead.",
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
            async: {
              type: "boolean",
              description:
                "Run asynchronously. Returns a jobId immediately instead of blocking. Use `codex-result` to poll for the result and `codex-cancel` to cancel.",
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
                "Run asynchronously. Returns a jobId immediately instead of blocking. Use `codex-result` to poll for the result and `codex-cancel` to cancel.",
            },
          },
          required: ["mode"],
        },
      },
      {
        name: "codex-result",
        description:
          "Get the status or result of an async Codex job. Returns the current job snapshot. Use `waitMs` for long-polling — the call blocks until the job changes state or the wait expires.",
        inputSchema: {
          type: "object",
          properties: {
            jobId: {
              type: "string",
              description: "Job ID from a previous async codex call",
            },
            waitMs: {
              type: "integer",
              minimum: 0,
              maximum: JOB_RESULT_WAIT_MAX_MS,
              description: `Optional long-poll timeout in milliseconds (max ${JOB_RESULT_WAIT_MAX_MS / 1000}s). If the job is still running, waits up to this long for a state change before returning.`,
            },
          },
          required: ["jobId"],
        },
      },
      {
        name: "codex-cancel",
        description:
          "Cancel a running async Codex job. If the job is still in progress, requests cancellation. If already completed, returns the current state unchanged.",
        inputSchema: {
          type: "object",
          properties: {
            jobId: {
              type: "string",
              description: "Job ID to cancel",
            },
          },
          required: ["jobId"],
        },
      },
    ],
  });
}

async function handleToolCall(message) {
  const { name, arguments: args } = message.params;

  try {
    // --- Async submissions ---
    if ((name === "codex" || name === "codex-reply" || name === "codex-review") && args.async) {
      let job;
      if (name === "codex") {
        job = await submitCodexStartJob(args);
      } else if (name === "codex-reply") {
        job = await submitCodexResumeJob(args);
      } else {
        job = await submitCodexReviewJob(args);
      }
      const snapshot = snapshotJob(job);
      sendResponse(message.id, {
        content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }],
      });
      return;
    }

    // --- New async tools ---
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
  if (evictionTimer) clearTimeout(evictionTimer);
  if (appServer) appServer.close();
  process.exit();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("end", shutdown);
