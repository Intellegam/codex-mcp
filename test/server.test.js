import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { spawn } from "child_process";
import { createInterface } from "readline";
import path from "path";

const SERVER_JS = path.join(import.meta.dir, "..", "server.js");
const MOCK_CODEX = path.join(import.meta.dir, "mock-codex.js");
const SERVER_CWD = path.join(import.meta.dir, "..");

// Make the mock codex binary findable as "codex" in PATH
const MOCK_BIN_DIR = path.join(import.meta.dir, "mock-bin");

beforeAll(async () => {
  const fs = await import("fs");
  fs.mkdirSync(MOCK_BIN_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(MOCK_BIN_DIR, "codex"),
    `#!/bin/sh\nexec node "${MOCK_CODEX}" "$@"\n`,
  );
  fs.chmodSync(path.join(MOCK_BIN_DIR, "codex"), 0o755);
});

afterAll(async () => {
  const fs = await import("fs");
  fs.rmSync(MOCK_BIN_DIR, { recursive: true, force: true });
});

/**
 * Spawn the MCP server with the mock codex in PATH.
 * Returns helpers to send MCP messages and read responses.
 */
function spawnServer(envOverrides = {}) {
  const proc = spawn("bun", [SERVER_JS], {
    cwd: SERVER_CWD,
    env: {
      ...process.env,
      PATH: `${MOCK_BIN_DIR}:${process.env.PATH}`,
      CODEX_TIMEOUT_MS: "3000", // short timeout for tests
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

  return { proc, send, waitResponse, mcpInit, close, getStderr: () => stderr };
}

// -------------------------------------------------------------------------

describe("MCP protocol", () => {
  let server;
  afterEach(() => server?.close());

  test("initialize returns server info", async () => {
    server = spawnServer();
    const resp = await server.mcpInit();
    expect(resp.result.serverInfo.name).toBe("codex-cli-wrapper");
    expect(resp.result.serverInfo.version).toBe("3.2.0");
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

    const final = await waitUntilDone(server, snap.sessionId, 300);
    expect(final.status).toBe("cancelled");
    expect(final.done).toBe(true);
    expect(final.cancelRequested).toBe(true);
    expect(final.error).toBeNull();
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
