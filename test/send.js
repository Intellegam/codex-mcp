#!/usr/bin/env node

/**
 * Send a single tool call to the MCP server and print the response.
 *
 * Usage:
 *   node test/send.js codex "What does this repo do?"
 *   node test/send.js codex --async "What does this repo do?"
 *   node test/send.js codex-reply <sessionId> "Follow-up question"
 *   node test/send.js codex-review uncommitted
 *   node test/send.js codex-review base main
 *   node test/send.js codex-review commit abc123
 *   node test/send.js codex-review custom "Focus on security"
 *   node test/send.js codex-result <jobId>
 *   node test/send.js codex-result <jobId> --wait 10000
 *   node test/send.js codex-cancel <jobId>
 */

const { spawn } = require("child_process");
const readline = require("readline");
const path = require("path");

const SERVER_JS = path.join(__dirname, "..", "server.js");
const CWD = process.cwd();

const rawArgs = process.argv.slice(2);
const tool = rawArgs[0];
const isAsync = rawArgs.includes("--async");
const rest = rawArgs.slice(1).filter((a) => a !== "--async");

if (!tool || tool === "--help" || tool === "-h") {
  console.log("Usage:");
  console.log('  node test/send.js codex "prompt"');
  console.log('  node test/send.js codex --async "prompt"');
  console.log('  node test/send.js codex-reply <sessionId> "prompt"');
  console.log("  node test/send.js codex-review uncommitted");
  console.log("  node test/send.js codex-review base <branch>");
  console.log("  node test/send.js codex-review commit <sha>");
  console.log('  node test/send.js codex-review custom "instructions"');
  console.log("  node test/send.js codex-result <jobId>");
  console.log("  node test/send.js codex-result <jobId> --wait 10000");
  console.log("  node test/send.js codex-cancel <jobId>");
  process.exit(0);
}

function buildArgs() {
  switch (tool) {
    case "codex": {
      const args = { prompt: rest.join(" ") || "Hello", cwd: CWD };
      if (isAsync) args.async = true;
      return args;
    }
    case "codex-reply": {
      const args = {
        sessionId: rest[0],
        prompt: rest.slice(1).join(" ") || "Continue",
        cwd: CWD,
      };
      if (isAsync) args.async = true;
      return args;
    }
    case "codex-review": {
      const mode = rest[0] || "uncommitted";
      const args = { mode, cwd: CWD };
      if (mode === "base") args.base = rest[1] || "main";
      if (mode === "commit") args.commit = rest[1];
      if (mode === "custom") args.prompt = rest.slice(1).join(" ");
      if (isAsync) args.async = true;
      return args;
    }
    case "codex-result": {
      const args = { jobId: rest[0] };
      const waitIdx = rest.indexOf("--wait");
      if (waitIdx !== -1) args.waitMs = parseInt(rest[waitIdx + 1], 10);
      return args;
    }
    case "codex-cancel":
      return { jobId: rest[0] };
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
      waiter = (msg) => {
        clearTimeout(t);
        resolve(msg);
      };
    });
  }

  rl.on("line", (line) => {
    try {
      const msg = JSON.parse(line);
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(msg);
      }
    } catch {}
  });

  function send(msg) {
    proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  function done() {
    proc.stdin.end();
    proc.kill("SIGTERM");
  }

  // Init
  send({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
  await wait();
  send({ jsonrpc: "2.0", method: "initialized", params: {} });

  // Call
  const args = buildArgs();
  console.error(`→ ${tool}(${JSON.stringify(args)})\n`);

  let nextId = 1;
  send({
    jsonrpc: "2.0",
    id: nextId++,
    method: "tools/call",
    params: { name: tool, arguments: args },
  });
  const resp = await wait();

  if (resp.error) {
    console.error(`Error: ${resp.error.message}`);
    done();
    process.exit(1);
  }

  for (const block of resp.result.content) {
    console.log(block.text);
  }

  // For async calls, poll codex-result until the job completes
  if (isAsync) {
    const snapshot = JSON.parse(resp.result.content[0].text);
    if (!snapshot.done) {
      console.error(`\n→ Polling codex-result (jobId: ${snapshot.jobId})...\n`);
      let result = snapshot;
      while (!result.done) {
        send({
          jsonrpc: "2.0",
          id: nextId++,
          method: "tools/call",
          params: {
            name: "codex-result",
            arguments: { jobId: result.jobId, waitMs: 30000 },
          },
        });
        const pollResp = await wait(60000);
        if (pollResp.error) {
          console.error(`Poll error: ${pollResp.error.message}`);
          done();
          process.exit(1);
        }
        result = JSON.parse(pollResp.result.content[0].text);
        console.error(
          `  status: ${result.status}, elapsed: ${result.elapsed}`,
        );
      }
      console.log(result.output);
      if (result.sessionId) {
        console.log(`\n[SESSION_ID: ${result.sessionId}]`);
      }
    }
  }

  done();
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
