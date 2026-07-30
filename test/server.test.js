import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { spawn } from "child_process";
import { createInterface } from "readline";
import fs from "fs";
import crypto from "crypto";
import os from "os";
import path from "path";

const SERVER_JS = path.join(import.meta.dir, "..", "server.js");
const MOCK_CODEX = path.join(import.meta.dir, "mock-codex.js");
const SERVER_CWD = path.join(import.meta.dir, "..");

// Make the mock codex binary findable as "codex" in PATH.
// Keep generated test state outside the checkout.
let mockTestDir;
let mockBinDir;
let mockArtifactDir;

beforeAll(async () => {
  mockTestDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mcp-test-"));
  mockBinDir = path.join(mockTestDir, "bin");
  mockArtifactDir = path.join(mockTestDir, "artifacts");
  fs.mkdirSync(mockBinDir, { recursive: true });
  fs.mkdirSync(mockArtifactDir, { recursive: true });
  fs.writeFileSync(
    path.join(mockBinDir, "codex"),
    `#!/bin/sh\nexec node "${MOCK_CODEX}" "$@"\n`,
  );
  fs.chmodSync(path.join(mockBinDir, "codex"), 0o755);
});

afterAll(async () => {
  if (mockTestDir) {
    fs.rmSync(mockTestDir, { recursive: true, force: true });
  }
});

/**
 * Spawn the MCP server with the mock codex in PATH.
 * Returns helpers to send MCP messages and read responses.
 */
function spawnServer(envOverrides = {}) {
  const instanceId = crypto.randomUUID();
  const eventLog =
    envOverrides.MOCK_EVENT_LOG ||
    path.join(mockArtifactDir, `${instanceId}.events.jsonl`);
  const stateFile =
    envOverrides.MOCK_STATE_FILE ||
    path.join(mockArtifactDir, `${instanceId}.state.json`);
  const proc = spawn("bun", [SERVER_JS], {
    cwd: SERVER_CWD,
    env: {
      ...process.env,
      PATH: `${mockBinDir}:${process.env.PATH}`,
      CODEX_TIMEOUT_MS: "3000", // short timeout for tests
      MOCK_EVENT_LOG: eventLog,
      MOCK_STATE_FILE: stateFile,
      ...envOverrides,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");

  let stderr = "";
  proc.stderr.on("data", (c) => (stderr += c));

  const rl = createInterface({ input: proc.stdout });
  const responseQueue = [];
  let waitResolve = null;

  rl.on("line", (line) => {
    try {
      const msg = JSON.parse(line);
      if (waitResolve) {
        const r = waitResolve;
        waitResolve = null;
        r(msg);
      } else {
        responseQueue.push(msg);
      }
    } catch {}
  });

  function send(msg) {
    proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  function waitResponse(timeoutMs = 10000) {
    if (responseQueue.length > 0) return Promise.resolve(responseQueue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("waitResponse timeout")), timeoutMs);
      waitResolve = (msg) => {
        clearTimeout(timer);
        resolve(msg);
      };
    });
  }

  async function mcpInit() {
    send({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
    const resp = await waitResponse();
    send({ jsonrpc: "2.0", method: "initialized", params: {} });
    return resp;
  }

  function close() {
    proc.stdin.end();
    proc.kill("SIGTERM");
  }

  function endInputAndWait(timeoutMs = 3000) {
    proc.stdin.end();
    if (proc.exitCode !== null) return Promise.resolve(proc.exitCode);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("server exit timeout")),
        timeoutMs,
      );
      proc.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  function getMockEvents() {
    if (!fs.existsSync(eventLog)) return [];
    return fs
      .readFileSync(eventLog, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  return {
    proc,
    send,
    waitResponse,
    mcpInit,
    close,
    endInputAndWait,
    getStderr: () => stderr,
    getMockEvents,
    eventLog,
    stateFile,
  };
}

async function waitForCondition(check, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function waitForMockMethod(server, method, timeoutMs = 3000) {
  return waitForCondition(
    () => server.getMockEvents().find((event) => event.method === method),
    `Mock never received ${method}`,
    timeoutMs,
  );
}

// -------------------------------------------------------------------------

describe("MCP protocol", () => {
  let server;
  afterEach(() => server?.close());

  test("initialize returns server info", async () => {
    server = spawnServer();
    const resp = await server.mcpInit();
    expect(resp.result.serverInfo.name).toBe("codex-mcp");
    expect(resp.result.serverInfo.version).toBe("3.2.6");
    expect(resp.result.protocolVersion).toBe("2024-11-05");
  });

  test("tools/list returns 5 tools", async () => {
    server = spawnServer();
    await server.mcpInit();
    server.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const resp = await server.waitResponse();
    const names = resp.result.tools.map((t) => t.name);
    expect(names).toEqual(["codex", "codex-reply", "codex-review", "codex-result", "codex-cancel"]);
  });

  test("unknown method returns error", async () => {
    server = spawnServer();
    await server.mcpInit();
    server.send({ jsonrpc: "2.0", id: 1, method: "unknown/method", params: {} });
    const resp = await server.waitResponse();
    expect(resp.error.code).toBe(-32601);
  });

  test("unknown tool returns error", async () => {
    server = spawnServer();
    await server.mcpInit();
    server.send({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "nonexistent", arguments: {} },
    });
    const resp = await server.waitResponse();
    expect(resp.error.code).toBe(-32602);
  });
});

describe("codex tool", () => {
  let server;
  afterEach(() => server?.close());

  test("returns response and session ID", async () => {
    server = spawnServer();
    await server.mcpInit();
    server.send({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "codex", arguments: { prompt: "hello" } },
    });
    const resp = await server.waitResponse();
    expect(resp.error).toBeUndefined();
    const texts = resp.result.content.map((c) => c.text);
    expect(texts[0]).toContain("Mock response to: hello");
    expect(texts[1]).toMatch(/\[SESSION_ID: thr_/);

    const start = server
      .getMockEvents()
      .find((event) => event.method === "thread/start");
    expect(start.params.ephemeral).toBe(false);
    const archive = await waitForMockMethod(server, "thread/archive");
    expect(archive.params.threadId).toBe(
      texts[1].match(/SESSION_ID: ([^\]]+)/)[1],
    );
  });

  test("graceful MCP shutdown waits for post-delivery archival", async () => {
    server = spawnServer({ MOCK_ARCHIVE_DELAY_MS: "100" });
    await server.mcpInit();
    server.send({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "codex", arguments: { prompt: "then disconnect" } },
    });
    const response = await server.waitResponse();
    const sessionId = response.result.content[1].text.match(/SESSION_ID: ([^\]]+)/)[1];

    const exitCode = await server.endInputAndWait();
    expect(exitCode).toBe(0);
    const persisted = JSON.parse(fs.readFileSync(server.stateFile, "utf8"));
    expect(persisted[sessionId].archived).toBe(true);
    server = null;
  });
});

describe("codex-reply tool", () => {
  let server;
  afterEach(() => server?.close());

  test("continues session in same connection", async () => {
    server = spawnServer();
    await server.mcpInit();

    // Start a session
    server.send({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "codex", arguments: { prompt: "first" } },
    });
    const startResp = await server.waitResponse();
    const sessionId = startResp.result.content[1].text.match(/SESSION_ID: ([^\]]+)/)[1];

    // Reply on same connection
    server.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "codex-reply", arguments: { sessionId, prompt: "follow-up" } },
    });
    const replyResp = await server.waitResponse();
    expect(replyResp.error).toBeUndefined();
    expect(replyResp.result.content[0].text).toContain("Mock response to: follow-up");
    expect(replyResp.result.content[1].text).toContain(sessionId);

    await waitForCondition(
      () =>
        server
          .getMockEvents()
          .filter((event) => event.method === "thread/archive").length === 2,
      "Both persistent turns were not archived",
    );
    const methods = server.getMockEvents().map((event) => event.method);
    expect(methods).toContain("thread/unarchive");
    expect(methods.filter((method) => method === "thread/archive").length).toBe(
      2,
    );
  });

  test("resumes an archived persistent session after MCP reconnection", async () => {
    const sharedState = path.join(
      mockArtifactDir,
      `${crypto.randomUUID()}.shared-state.json`,
    );
    const sharedEvents = path.join(
      mockArtifactDir,
      `${crypto.randomUUID()}.shared-events.jsonl`,
    );

    const firstServer = spawnServer({
      MOCK_STATE_FILE: sharedState,
      MOCK_EVENT_LOG: sharedEvents,
    });
    await firstServer.mcpInit();
    firstServer.send({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "codex", arguments: { prompt: "first" } },
    });
    const startResp = await firstServer.waitResponse();
    const sessionId = startResp.result.content[1].text.match(/SESSION_ID: ([^\]]+)/)[1];
    await waitForMockMethod(firstServer, "thread/archive");
    await waitForCondition(
      () => {
        if (!fs.existsSync(sharedState)) return false;
        return JSON.parse(fs.readFileSync(sharedState, "utf8"))[sessionId]
          ?.archived;
      },
      "Persistent thread was not archived in shared mock state",
    );
    firstServer.close();

    server = spawnServer({
      MOCK_STATE_FILE: sharedState,
      MOCK_EVENT_LOG: sharedEvents,
    });
    await server.mcpInit();
    server.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "codex-reply", arguments: { sessionId, prompt: "after reconnect" } },
    });
    const replyResp = await server.waitResponse();
    expect(replyResp.error).toBeUndefined();
    expect(replyResp.result.content[0].text).toContain("after reconnect");

    await waitForCondition(
      () =>
        server
          .getMockEvents()
          .filter((event) => event.method === "thread/archive").length === 2,
      "Follow-up turn was not re-archived",
    );
    const lifecycle = server
      .getMockEvents()
      .map((event) => event.method)
      .filter((method) =>
        ["thread/resume", "thread/unarchive", "thread/archive"].includes(method),
      );
    expect(lifecycle).toEqual([
      "thread/archive",
      "thread/resume",
      "thread/unarchive",
      "thread/resume",
      "thread/archive",
    ]);
  });

  test("resume fails for unknown session", async () => {
    server = spawnServer();
    await server.mcpInit();
    server.send({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "codex-reply", arguments: { sessionId: "nonexistent", prompt: "hi" } },
    });
    const resp = await server.waitResponse();
    expect(resp.error).toBeDefined();
    expect(resp.error.message).toContain("no rollout found");
  });
});

describe("codex-review tool", () => {
  let server;
  afterEach(() => server?.close());

  test("returns review with session ID", async () => {
    server = spawnServer();
    await server.mcpInit();
    server.send({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "codex-review", arguments: { mode: "uncommitted" } },
    });
    const resp = await server.waitResponse();
    expect(resp.error).toBeUndefined();
    expect(resp.result.content[0].text).toContain("Mock review: code looks good.");
    expect(resp.result.content[1].text).toMatch(/SESSION_ID:/);

    const start = server
      .getMockEvents()
      .find((event) => event.method === "thread/start");
    expect(start.params.ephemeral).toBe(true);
    expect(
      server
        .getMockEvents()
        .some((event) => event.method === "thread/archive"),
    ).toBe(false);
  });

  test("ephemeral review supports same-connection follow-up without archival", async () => {
    server = spawnServer();
    await server.mcpInit();
    server.send({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "codex-review", arguments: { mode: "uncommitted" } },
    });
    const reviewResp = await server.waitResponse();
    const sessionId = reviewResp.result.content[1].text.match(/SESSION_ID: ([^\]]+)/)[1];

    server.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "codex-reply", arguments: { sessionId, prompt: "clarify" } },
    });
    const replyResp = await server.waitResponse();
    expect(replyResp.error).toBeUndefined();
    expect(replyResp.result.content[0].text).toContain("clarify");
    expect(
      server
        .getMockEvents()
        .some((event) => event.method === "thread/archive"),
    ).toBe(false);
  });

  test("rejects missing mode", async () => {
    server = spawnServer();
    await server.mcpInit();
    server.send({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "codex-review", arguments: {} },
    });
    const resp = await server.waitResponse();
    expect(resp.error.message).toContain("requires mode");
  });

  test("rejects base mode without base param", async () => {
    server = spawnServer();
    await server.mcpInit();
    server.send({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "codex-review", arguments: { mode: "base" } },
    });
    const resp = await server.waitResponse();
    expect(resp.error.message).toContain("requires base");
  });

  test("rejects commit mode without commit param", async () => {
    server = spawnServer();
    await server.mcpInit();
    server.send({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "codex-review", arguments: { mode: "commit" } },
    });
    const resp = await server.waitResponse();
    expect(resp.error.message).toContain("requires commit");
  });

  test("rejects custom mode without prompt", async () => {
    server = spawnServer();
    await server.mcpInit();
    server.send({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "codex-review", arguments: { mode: "custom" } },
    });
    const resp = await server.waitResponse();
    expect(resp.error.message).toContain("requires prompt");
  });
});

describe("timeout and error handling", () => {
  let server;
  afterEach(() => server?.close());

  test("times out and returns error", async () => {
    server = spawnServer({ MOCK_TURN_DELAY_MS: "60000", CODEX_TIMEOUT_MS: "500" });
    await server.mcpInit();
    server.send({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "codex", arguments: { prompt: "slow" } },
    });
    const resp = await server.waitResponse(5000);
    expect(resp.error).toBeDefined();
    expect(resp.error.message).toContain("timed out");
    await waitForMockMethod(server, "thread/archive");
  });

  test("app-server crash rejects immediately", async () => {
    server = spawnServer({ MOCK_CRASH_AFTER_TURN_START: "1" });
    await server.mcpInit();
    server.send({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "codex", arguments: { prompt: "crash" } },
    });
    const resp = await server.waitResponse(5000);
    expect(resp.error).toBeDefined();
    expect(resp.error.message).not.toContain("timed out");
  });
});

// -------------------------------------------------------------------------
// Helpers for async tests — all keyed by sessionId (the only user-facing ID)
// -------------------------------------------------------------------------

function parseSnapshot(resp) {
  expect(resp.error).toBeUndefined();
  return JSON.parse(resp.result.content[0].text);
}

async function asyncCall(server, id, name, args) {
  server.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  return server.waitResponse();
}

async function pollUntilStatus(server, sessionId, targetStatus, idStart = 100) {
  let id = idStart;
  for (let i = 0; i < 50; i++) {
    const resp = await asyncCall(server, id++, "codex-result", { sessionId });
    const snap = parseSnapshot(resp);
    if (snap.status === targetStatus || snap.done) return snap;
    // Brief pause to avoid tight loop
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Session ${sessionId} never reached status ${targetStatus}`);
}

async function waitUntilDone(server, sessionId, id = 100) {
  const resp = await asyncCall(server, id, "codex-result", { sessionId, wait: true });
  return parseSnapshot(resp);
}

// -------------------------------------------------------------------------

describe("async codex", () => {
  let server;
  afterEach(() => server?.close());

  test("start -> poll -> result", async () => {
    server = spawnServer({ MOCK_TURN_DELAY_MS: "100" });
    await server.mcpInit();

    const resp = await asyncCall(server, 1, "codex", { prompt: "async hello", async: true });
    const snap = parseSnapshot(resp);
    expect(snap.sessionId).toBeDefined();
    expect(snap.toolName).toBe("codex");
    expect(snap.done).toBe(false);
    expect(snap.output).toBe("");

    const final = await waitUntilDone(server, snap.sessionId);
    expect(final.status).toBe("succeeded");
    expect(final.done).toBe(true);
    expect(final.sessionId).toBe(snap.sessionId);
    expect(final.output).toContain("Mock response to: async hello");
    expect(final.error).toBeNull();
    await waitForMockMethod(server, "thread/archive");
  });

  test("does not archive a terminal async turn until codex-result delivers it", async () => {
    server = spawnServer({ MOCK_TURN_DELAY_MS: "25" });
    await server.mcpInit();

    const response = await asyncCall(server, 1, "codex", {
      prompt: "deferred delivery",
      async: true,
    });
    const started = parseSnapshot(response);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(
      server
        .getMockEvents()
        .some((event) => event.method === "thread/archive"),
    ).toBe(false);

    const resultResponse = await asyncCall(server, 2, "codex-result", {
      sessionId: started.sessionId,
    });
    const terminal = parseSnapshot(resultResponse);
    expect(terminal.done).toBe(true);
    expect(terminal.status).toBe("succeeded");
    await waitForMockMethod(server, "thread/archive");
  });

  test("nonterminal codex-result polling does not archive", async () => {
    server = spawnServer({ MOCK_TURN_DELAY_MS: "200" });
    await server.mcpInit();

    const response = await asyncCall(server, 1, "codex", {
      prompt: "still running",
      async: true,
    });
    const started = parseSnapshot(response);
    const pollResponse = await asyncCall(server, 2, "codex-result", {
      sessionId: started.sessionId,
    });
    const running = parseSnapshot(pollResponse);
    expect(running.done).toBe(false);
    expect(
      server
        .getMockEvents()
        .some((event) => event.method === "thread/archive"),
    ).toBe(false);

    const terminal = await waitUntilDone(server, started.sessionId, 3);
    expect(terminal.done).toBe(true);
    await waitForMockMethod(server, "thread/archive");
  });

  test("terminal result delivery archives only once", async () => {
    server = spawnServer();
    await server.mcpInit();

    const response = await asyncCall(server, 1, "codex", {
      prompt: "one archive",
      async: true,
    });
    const started = parseSnapshot(response);
    await waitUntilDone(server, started.sessionId, 2);
    await waitForMockMethod(server, "thread/archive");

    const secondResult = await asyncCall(server, 3, "codex-result", {
      sessionId: started.sessionId,
    });
    expect(parseSnapshot(secondResult).done).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      server
        .getMockEvents()
        .filter((event) => event.method === "thread/archive").length,
    ).toBe(1);
  });

  test("codex-result wait: true blocks until done", async () => {
    server = spawnServer({ MOCK_TURN_DELAY_MS: "200" });
    await server.mcpInit();

    const resp = await asyncCall(server, 1, "codex", { prompt: "wait test", async: true });
    const snap = parseSnapshot(resp);
    expect(snap.done).toBe(false);

    const final = await waitUntilDone(server, snap.sessionId);
    expect(final.status).toBe("succeeded");
    expect(final.done).toBe(true);
    expect(final.output).toContain("Mock response to: wait test");
  });

  test("codex-result without wait returns immediately", async () => {
    server = spawnServer({ MOCK_TURN_DELAY_MS: "5000" });
    await server.mcpInit();

    const resp = await asyncCall(server, 1, "codex", { prompt: "slow", async: true });
    const snap = parseSnapshot(resp);

    await pollUntilStatus(server, snap.sessionId, "running");

    const before = Date.now();
    const pollResp = await asyncCall(server, 200, "codex-result", { sessionId: snap.sessionId });
    const elapsed = Date.now() - before;
    const current = parseSnapshot(pollResp);

    expect(current.done).toBe(false);
    expect(current.status).toBe("running");
    expect(elapsed).toBeLessThan(500);

    // Cleanup
    await asyncCall(server, 300, "codex-cancel", { sessionId: snap.sessionId });
    await waitUntilDone(server, snap.sessionId, 400);
  });

  test("cancel while running", async () => {
    server = spawnServer({ MOCK_TURN_DELAY_MS: "5000" });
    await server.mcpInit();

    const resp = await asyncCall(server, 1, "codex", { prompt: "cancel me", async: true });
    const snap = parseSnapshot(resp);

    await pollUntilStatus(server, snap.sessionId, "running");

    const cancelResp = await asyncCall(server, 200, "codex-cancel", { sessionId: snap.sessionId });
    const cancelSnap = parseSnapshot(cancelResp);
    expect(cancelSnap.cancelRequested).toBe(true);
    expect(
      server
        .getMockEvents()
        .some((event) => event.method === "thread/archive"),
    ).toBe(false);

    const final = await waitUntilDone(server, snap.sessionId, 300);
    expect(final.status).toBe("cancelled");
    expect(final.done).toBe(true);
    expect(final.cancelRequested).toBe(true);
    expect(final.error).toBeNull();
    await waitForMockMethod(server, "thread/archive");
  });

  test("cancel after done is a no-op", async () => {
    server = spawnServer({ MOCK_TURN_DELAY_MS: "0" });
    await server.mcpInit();

    const resp = await asyncCall(server, 1, "codex", { prompt: "fast", async: true });
    const snap = parseSnapshot(resp);

    const final = await waitUntilDone(server, snap.sessionId);
    expect(final.status).toBe("succeeded");

    const cancelResp = await asyncCall(server, 200, "codex-cancel", { sessionId: snap.sessionId });
    const cancelSnap = parseSnapshot(cancelResp);
    expect(cancelSnap.status).toBe("succeeded");
    expect(cancelSnap.cancelRequested).toBe(false);
  });

  test("thread guard rejects concurrent turn on same session", async () => {
    server = spawnServer({ MOCK_TURN_DELAY_MS: "5000" });
    await server.mcpInit();

    const resp1 = await asyncCall(server, 1, "codex", { prompt: "first", async: true });
    const snap1 = parseSnapshot(resp1);

    await pollUntilStatus(server, snap1.sessionId, "running");

    // Try a codex-reply on the same session while turn 1 is running
    const resp2 = await asyncCall(server, 2, "codex-reply", {
      sessionId: snap1.sessionId, prompt: "second", async: true,
    });
    const snap2 = parseSnapshot(resp2);
    expect(snap2.status).toBe("failed");
    expect(snap2.done).toBe(true);
    expect(snap2.error.source).toBe("setup");
    expect(snap2.error.message).toContain("already has an active turn");

    // Cleanup
    await asyncCall(server, 300, "codex-cancel", { sessionId: snap1.sessionId });
    await waitUntilDone(server, snap1.sessionId, 400);
  });

  test("async turn timeout becomes timed_out", async () => {
    server = spawnServer({ MOCK_TURN_DELAY_MS: "60000", CODEX_TIMEOUT_MS: "500" });
    await server.mcpInit();

    const resp = await asyncCall(server, 1, "codex", { prompt: "will timeout", async: true });
    const snap = parseSnapshot(resp);
    expect(snap.sessionId).toBeDefined();
    expect(snap.done).toBe(false);

    const final = await waitUntilDone(server, snap.sessionId);
    expect(final.status).toBe("timed_out");
    expect(final.done).toBe(true);
    expect(final.cancelRequested).toBe(true);
    expect(final.error.source).toMatch(/timeout|cancel/);
    await waitForMockMethod(server, "thread/archive");
  });
});

describe("archive failure handling", () => {
  let server;
  afterEach(() => server?.close());

  test("does not replace a delivered task result and exposes the later failure", async () => {
    server = spawnServer({ MOCK_ARCHIVE_FAIL: "1" });
    await server.mcpInit();
    server.send({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "codex", arguments: { prompt: "keep my result" } },
    });
    const response = await server.waitResponse();
    expect(response.error).toBeUndefined();
    expect(response.result.content[0].text).toContain("keep my result");
    const sessionId = response.result.content[1].text.match(/SESSION_ID: ([^\]]+)/)[1];

    await waitForCondition(
      () => server.getStderr().includes("mock archive failure"),
      "Archive failure was not logged",
    );
    const resultResponse = await asyncCall(server, 2, "codex-result", {
      sessionId,
    });
    const snapshot = parseSnapshot(resultResponse);
    expect(snapshot.status).toBe("succeeded");
    expect(snapshot.output).toContain("keep my result");
    expect(snapshot.archiveError).toEqual({
      message: "mock archive failure",
      source: "archive",
    });
  });
});

describe("async error handling", () => {
  let server;
  afterEach(() => server?.close());

  test("codex-result rejects unknown sessionId", async () => {
    server = spawnServer();
    await server.mcpInit();
    server.send({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "codex-result", arguments: { sessionId: "does-not-exist" } },
    });
    const resp = await server.waitResponse();
    expect(resp.error).toBeDefined();
    expect(resp.error.message).toContain("Unknown sessionId");
  });

  test("codex-cancel rejects unknown sessionId", async () => {
    server = spawnServer();
    await server.mcpInit();
    server.send({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "codex-cancel", arguments: { sessionId: "does-not-exist" } },
    });
    const resp = await server.waitResponse();
    expect(resp.error).toBeDefined();
    expect(resp.error.message).toContain("Unknown sessionId");
  });

  test("async review with invalid args returns failed snapshot", async () => {
    server = spawnServer();
    await server.mcpInit();
    const resp = await asyncCall(server, 1, "codex-review", { async: true });
    const snap = parseSnapshot(resp);
    expect(snap.toolName).toBe("codex-review");
    expect(snap.status).toBe("failed");
    expect(snap.done).toBe(true);
    expect(snap.error.source).toBe("setup");
    expect(snap.error.message).toContain("codex-review requires mode");
    expect(snap.sessionId).toBeNull();
  });
});
