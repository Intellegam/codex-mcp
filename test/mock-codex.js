#!/usr/bin/env node

/**
 * Mock codex binary for testing. When invoked as `codex app-server`,
 * speaks the app-server JSON-RPC protocol over stdio with canned responses.
 */

const readline = require("readline");
const fs = require("fs");

if (process.argv[2] !== "app-server") {
  console.error("mock-codex: only app-server subcommand is supported");
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin });

const stateFile = process.env.MOCK_STATE_FILE;
const eventLog = process.env.MOCK_EVENT_LOG;
const failArchive = process.env.MOCK_ARCHIVE_FAIL === "1";
const archiveDelay =
  parseInt(process.env.MOCK_ARCHIVE_DELAY_MS, 10) || 0;

// Track persistent state across mock app-server processes when requested.
const threads = new Map();
if (stateFile && fs.existsSync(stateFile)) {
  try {
    const stored = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    for (const [threadId, state] of Object.entries(stored)) {
      threads.set(threadId, state);
    }
  } catch {
    // Tests should surface malformed state through subsequent protocol failures.
  }
}
let crashAfterTurnStart = process.env.MOCK_CRASH_AFTER_TURN_START === "1";
let turnDelay = parseInt(process.env.MOCK_TURN_DELAY_MS, 10) || 0;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function record(method, params) {
  if (!eventLog) return;
  fs.appendFileSync(
    eventLog,
    JSON.stringify({ method, params, at: Date.now() }) + "\n",
  );
}

function saveThreads() {
  if (!stateFile) return;
  const persistentThreads = {};
  for (const [threadId, state] of threads) {
    if (!state.ephemeral) persistentThreads[threadId] = state;
  }
  fs.writeFileSync(stateFile, JSON.stringify(persistentThreads));
}

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  // Notification (no id) — ignore
  if (msg.id === undefined) return;

  const { id, method, params } = msg;
  record(method, params);

  switch (method) {
    case "initialize":
      send({ id, result: { serverInfo: { name: "mock-codex", version: "0.0.1" } } });
      break;

    case "thread/start": {
      const threadId = `thr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      threads.set(threadId, {
        cwd: params.cwd,
        sandbox: params.sandbox,
        ephemeral: params.ephemeral,
        archived: false,
      });
      saveThreads();
      send({
        id,
        result: {
          thread: {
            id: threadId,
            path: params.ephemeral ? null : `/tmp/mock-sessions/${threadId}.jsonl`,
            ephemeral: params.ephemeral ?? false,
            cwd: params.cwd,
          },
          approvalPolicy: params.approvalPolicy || "never",
          approvalsReviewer: "user",
          cwd: params.cwd || process.cwd(),
          model: "mock-model",
          modelProvider: "mock",
          sandbox: { type: params.sandbox === "workspace-write" ? "workspaceWrite" : "readOnly" },
        },
      });
      break;
    }

    case "thread/resume": {
      const threadId = params.threadId;
      const thread = threads.get(threadId);
      if (thread?.archived) {
        send({
          id,
          error: {
            code: -32600,
            message: `session ${threadId} is archived. Run codex unarchive ${threadId} first`,
          },
        });
      } else if (thread) {
        send({ id, result: { thread: { id: threadId, turns: [], status: "loaded" } } });
      } else {
        send({ id, error: { code: -32600, message: `no rollout found for thread id ${threadId}` } });
      }
      break;
    }

    case "thread/archive": {
      const threadId = params.threadId;
      const thread = threads.get(threadId);
      setTimeout(() => {
        if (failArchive) {
          send({
            id,
            error: { code: -32603, message: "mock archive failure" },
          });
        } else if (!thread) {
          send({
            id,
            error: {
              code: -32600,
              message: `no rollout found for thread id ${threadId}`,
            },
          });
        } else {
          thread.archived = true;
          saveThreads();
          send({ id, result: {} });
        }
      }, archiveDelay);
      break;
    }

    case "thread/unarchive": {
      const threadId = params.threadId;
      const thread = threads.get(threadId);
      if (!thread) {
        send({
          id,
          error: {
            code: -32600,
            message: `no rollout found for thread id ${threadId}`,
          },
        });
      } else {
        thread.archived = false;
        saveThreads();
        send({ id, result: { thread: { id: threadId } } });
      }
      break;
    }

    case "turn/start": {
      const threadId = params.threadId;
      const turnId = `turn_${Date.now()}`;

      // Return the RPC response
      send({ id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });

      if (crashAfterTurnStart) {
        // Simulate app-server crash mid-turn
        setTimeout(() => process.exit(1), 50);
        return;
      }

      // Send notifications after a delay
      setTimeout(() => {
        send({ method: "turn/started", params: { threadId, turn: { id: turnId } } });

        const prompt = params.input?.[0]?.text || "";
        const responseText = `Mock response to: ${prompt}`;

        send({
          method: "item/completed",
          params: {
            threadId,
            item: { type: "agentMessage", text: responseText, phase: "final_answer" },
          },
        });

        send({
          method: "turn/completed",
          params: { threadId, turn: { id: turnId, status: "completed", items: [] } },
        });
      }, turnDelay);
      break;
    }

    case "review/start": {
      const threadId = params.threadId;
      const turnId = `turn_review_${Date.now()}`;

      send({ id, result: { turn: { id: turnId, status: "inProgress", items: [] }, reviewThreadId: threadId } });

      setTimeout(() => {
        send({ method: "turn/started", params: { threadId, turn: { id: turnId } } });

        send({
          method: "item/completed",
          params: {
            threadId,
            item: { type: "exitedReviewMode", review: "Mock review: code looks good." },
          },
        });

        send({
          method: "turn/completed",
          params: { threadId, turn: { id: turnId, status: "completed", items: [] } },
        });
      }, turnDelay);
      break;
    }

    case "turn/interrupt": {
      send({ id, result: {} });
      // Simulate the turn completing after interrupt
      const intThreadId = params.threadId;
      const intTurnId = params.turnId;
      setTimeout(() => {
        send({
          method: "turn/completed",
          params: { threadId: intThreadId, turn: { id: intTurnId, status: "completed", items: [] } },
        });
      }, 10);
      break;
    }

    default:
      send({ id, error: { code: -32601, message: `Unknown method: ${method}` } });
  }
});
