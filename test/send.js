#!/usr/bin/env node

/**
 * Send a single tool call to the MCP server and print the response.
 *
 * Usage:
 *   node test/send.js codex "What does this repo do?"
 *   node test/send.js codex-reply <sessionId> "Follow-up question"
 *   node test/send.js codex-review uncommitted
 *   node test/send.js codex-review base main
 *   node test/send.js codex-review commit abc123
 *   node test/send.js codex-review custom "Focus on security"
 */

const { spawn } = require("child_process");
const readline = require("readline");
const path = require("path");

const SERVER_JS = path.join(__dirname, "..", "server.js");
const CWD = process.cwd();

const [tool, ...rest] = process.argv.slice(2);

if (!tool || tool === "--help" || tool === "-h") {
  console.log("Usage:");
  console.log('  node test/send.js codex "prompt"');
  console.log('  node test/send.js codex-reply <sessionId> "prompt"');
  console.log("  node test/send.js codex-review uncommitted");
  console.log("  node test/send.js codex-review base <branch>");
  console.log("  node test/send.js codex-review commit <sha>");
  console.log('  node test/send.js codex-review custom "instructions"');
  process.exit(0);
}

function buildArgs() {
  switch (tool) {
    case "codex":
      return { prompt: rest.join(" ") || "Hello", cwd: CWD };
    case "codex-reply":
      return { sessionId: rest[0], prompt: rest.slice(1).join(" ") || "Continue", cwd: CWD };
    case "codex-review": {
      const mode = rest[0] || "uncommitted";
      const args = { mode, cwd: CWD };
      if (mode === "base") args.base = rest[1] || "main";
      if (mode === "commit") args.commit = rest[1];
      if (mode === "custom") args.prompt = rest.slice(1).join(" ");
      return args;
    }
    default:
      console.error(`Unknown tool: ${tool}`);
      process.exit(1);
  }
}

async function main() {
  const proc = spawn("node", [SERVER_JS], {
    cwd: CWD,
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (c) => process.stderr.write(c));

  proc.stdout.setEncoding("utf8");
  const rl = readline.createInterface({ input: proc.stdout });
  let waiter = null;

  function wait(ms = 600000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), ms);
      waiter = (msg) => { clearTimeout(t); resolve(msg); };
    });
  }

  rl.on("line", (line) => {
    try {
      const msg = JSON.parse(line);
      if (waiter) { const w = waiter; waiter = null; w(msg); }
    } catch {}
  });

  function send(msg) { proc.stdin.write(JSON.stringify(msg) + "\n"); }

  // Init
  send({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
  await wait();
  send({ jsonrpc: "2.0", method: "initialized", params: {} });

  // Call
  const args = buildArgs();
  console.error(`→ ${tool}(${JSON.stringify(args)})\n`);

  send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } });
  const resp = await wait();

  if (resp.error) {
    console.error(`Error: ${resp.error.message}`);
    proc.kill();
    process.exit(1);
  }

  for (const block of resp.result.content) {
    console.log(block.text);
  }

  proc.stdin.end();
  proc.kill("SIGTERM");
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
