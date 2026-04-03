#!/usr/bin/env node

/**
 * Smoke test — spawns the MCP server, sends real tool calls through to Codex,
 * and verifies the responses. Requires a working `codex` CLI with auth.
 *
 * Usage: node test/smoke.js
 */

const { spawn } = require("child_process");
const readline = require("readline");
const path = require("path");

const SERVER_JS = path.join(__dirname, "..", "server.js");
const CWD = path.join(__dirname, "..");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    failed++;
  }
}

function spawnMcpServer() {
  const proc = spawn("node", [SERVER_JS], {
    cwd: CWD,
    env: { ...process.env, CODEX_TIMEOUT_MS: "120000" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");

  const rl = readline.createInterface({ input: proc.stdout });
  const queue = [];
  let waiter = null;

  rl.on("line", (line) => {
    try {
      const msg = JSON.parse(line);
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(msg);
      } else {
        queue.push(msg);
      }
    } catch {}
  });

  return {
    send(msg) { proc.stdin.write(JSON.stringify(msg) + "\n"); },
    wait(ms = 120000) {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("response timeout")), ms);
        waiter = (msg) => { clearTimeout(t); resolve(msg); };
      });
    },
    async init() {
      this.send({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
      await this.wait();
      this.send({ jsonrpc: "2.0", method: "initialized", params: {} });
    },
    close() { proc.stdin.end(); proc.kill("SIGTERM"); },
    proc,
  };
}

async function main() {
  console.log("Smoke test — real Codex integration\n");

  const s = spawnMcpServer();

  // --- Init ---
  console.log("1. Initialize");
  await s.init();
  assert(true, "MCP handshake completed");

  // --- Tools list ---
  console.log("2. Tools list");
  s.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const toolsResp = await s.wait();
  const tools = toolsResp.result?.tools?.map((t) => t.name) || [];
  assert(tools.includes("codex"), "codex tool listed");
  assert(tools.includes("codex-reply"), "codex-reply tool listed");
  assert(tools.includes("codex-review"), "codex-review tool listed");

  // --- Codex ---
  console.log("3. codex tool");
  s.send({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "codex", arguments: { prompt: "Say just the word pong. Nothing else.", cwd: CWD } },
  });
  const codexResp = await s.wait();
  const codexTexts = codexResp.result?.content?.map((c) => c.text) || [];
  assert(!codexResp.error, "no error");
  assert(codexTexts[0]?.length > 0, `got response: "${codexTexts[0]?.substring(0, 80)}"`);
  const sessionMatch = codexTexts[1]?.match(/SESSION_ID: ([^\]]+)/);
  assert(!!sessionMatch, `got session ID: ${sessionMatch?.[1]?.substring(0, 20)}...`);

  // --- Codex Reply ---
  if (sessionMatch) {
    const sessionId = sessionMatch[1];
    console.log("4. codex-reply tool (same connection)");
    s.send({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "codex-reply", arguments: { sessionId, prompt: "What did I just ask you?" } },
    });
    const replyResp = await s.wait();
    const replyTexts = replyResp.result?.content?.map((c) => c.text) || [];
    assert(!replyResp.error, "no error");
    assert(replyTexts[0]?.length > 0, `got reply: "${replyTexts[0]?.substring(0, 80)}"`);
  } else {
    console.log("4. codex-reply SKIPPED (no session ID)");
  }

  // --- Review ---
  console.log("5. codex-review tool (reviews can take several minutes)");
  s.send({
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "codex-review", arguments: { mode: "uncommitted", cwd: CWD } },
  });
  const reviewResp = await s.wait(300000); // 5 min — reviews are slow
  if (reviewResp.error) {
    assert(false, `review error: ${reviewResp.error.message?.substring(0, 80)}`);
  } else {
    const reviewTexts = reviewResp.result?.content?.map((c) => c.text) || [];
    assert(reviewTexts[0]?.length > 0, `got review: "${reviewTexts[0]?.substring(0, 80)}..."`);
    assert(reviewTexts.length === 1, "no session ID returned for review");
  }

  // --- Done ---
  s.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
