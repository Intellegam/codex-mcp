#!/usr/bin/env node

/**
 * Codex CLI-based MCP Server
 *
 * Acts as an MCP server but uses Codex CLI internally.
 * This gives us session IDs reliably from JSON output!
 */

const { spawn } = require("child_process");
const readline = require("readline");

// MCP protocol uses JSON-RPC over stdio
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

// Store active sessions: sessionId -> {prompt, created}
const sessions = new Map();

// Handle incoming JSON-RPC messages
rl.on("line", async (line) => {
  try {
    const message = JSON.parse(line);

    // Route different MCP methods
    switch (message.method) {
      case "initialize":
        handleInitialize(message);
        break;

      case "initialized":
        // Client confirming initialization
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
      version: "1.1.1",
    },
    instructions:
      "IMPORTANT: Read the `collaborating-with-codex` skill before using any Codex tools. Codex is an external AI agent for second opinions on complex decisions. Form your own analysis first to avoid anchoring bias, then use Codex for brainstorming, plan validation, or code review. Sessions run in read-only sandbox mode.",
  });
}

function handleToolsList(message) {
  sendResponse(message.id, {
    tools: [
      {
        name: "codex",
        description:
          "Start a new Codex session. Use like a sub-agent: be specific in prompts, provide context. Sessions can be resumed with codex-reply.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "The prompt for Codex" },
            cwd: { type: "string", description: "Working directory" },
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
          },
          required: ["sessionId", "prompt"],
        },
      },
      {
        name: "codex-review",
        description:
          "Run a Codex code review. In review mode, Codex uses a specialized review prompt. For reviews needing prior conversation context, use codex-reply instead.",
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
    if (name === "codex") {
      const result = await runCodexStart(args);
      sendResponse(message.id, {
        content: [
          { type: "text", text: result.output },
          { type: "text", text: `\n[SESSION_ID: ${result.sessionId}]` },
        ],
      });
    } else if (name === "codex-reply") {
      const result = await runCodexResume(args.sessionId, args.prompt);
      sendResponse(message.id, {
        content: [
          { type: "text", text: result.output },
          { type: "text", text: `\n[SESSION_ID: ${result.sessionId}]` },
        ],
      });
    } else if (name === "codex-review") {
      const result = await runCodexReview(args);
      sendResponse(message.id, {
        content: [
          { type: "text", text: result.output },
          { type: "text", text: `\n[SESSION_ID: ${result.sessionId}]` },
        ],
      });
    } else {
      sendError(message.id, -32602, `Unknown tool: ${name}`);
    }
  } catch (e) {
    sendError(message.id, -32603, e.message);
  }
}

function runCodexStart(args) {
  // Build CLI command
  const cliArgs = ["exec", args.prompt];

  // Always use read-only sandbox for safety
  cliArgs.push("--sandbox", "read-only");
  if (args.cwd) {
    cliArgs.push("-C", args.cwd);
  }

  // Add JSON flag to get structured output
  cliArgs.push("--json");

  return runCodexJsonl(cliArgs, {
    cwd: args.cwd,
    label: "Codex",
  }).then((result) => {
    // Store session info
    sessions.set(result.sessionId, {
      created: Date.now(),
      initialPrompt: args.prompt,
    });
    return result;
  });
}

function runCodexResume(sessionId, prompt) {
  const cliArgs = ["exec", "--json", "resume", sessionId, prompt];
  return runCodexJsonl(cliArgs, {
    cwd: undefined,
    label: "Codex resume",
  });
}

function runCodexReview(args) {
  if (!args || !args.mode) {
    return Promise.reject(new Error("codex-review requires mode"));
  }

  // Build CLI command: codex exec [exec opts] --json review [review opts] [PROMPT]
  const cliArgs = ["exec"];

  if (args.cwd) {
    cliArgs.push("-C", args.cwd);
  }

  // JSON output must come before subcommand
  cliArgs.push("--json");
  cliArgs.push("review");

  switch (args.mode) {
    case "uncommitted":
      cliArgs.push("--uncommitted");
      break;
    case "base":
      if (!args.base) {
        return Promise.reject(new Error("mode=base requires base"));
      }
      cliArgs.push("--base", String(args.base));
      break;
    case "commit":
      if (!args.commit) {
        return Promise.reject(new Error("mode=commit requires commit"));
      }
      cliArgs.push("--commit", String(args.commit));
      break;
    case "custom":
      if (!args.prompt || !args.prompt.trim()) {
        return Promise.reject(new Error("mode=custom requires prompt"));
      }
      cliArgs.push(args.prompt.trim());
      break;
    default:
      return Promise.reject(new Error(`Unknown review mode: ${args.mode}`));
  }

  return runCodexJsonl(cliArgs, {
    cwd: args.cwd,
    label: "Codex review",
  });
}

function runCodexJsonl(cliArgs, { cwd, label }) {
  return new Promise((resolve, reject) => {
    const proc = spawn("codex", cliArgs, {
      env: process.env,
      cwd: cwd || process.cwd(),
    });

    const stdoutRl = readline.createInterface({
      input: proc.stdout,
      crlfDelay: Infinity,
    });

    let rawOutput = "";
    let sessionId = null;
    let finalMessage = "";

    stdoutRl.on("line", (line) => {
      rawOutput += `${line}\n`;
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const json = JSON.parse(trimmed);

        if (json.type === "thread.started" && json.thread_id) {
          sessionId = json.thread_id;
        }

        if (
          json.type === "item.completed" &&
          json.item?.type === "agent_message" &&
          json.item?.text
        ) {
          finalMessage = json.item.text;
        }
      } catch (e) {
        // Not JSON, ignore
      }
    });

    proc.stderr.on("data", (data) => {
      console.error(`${label} stderr:`, data.toString());
    });

    proc.on("error", (err) => {
      stdoutRl.close();
      reject(err);
    });

    proc.on("close", (code) => {
      stdoutRl.close();

      if (code !== 0) {
        reject(new Error(`${label} exited with code ${code}`));
        return;
      }

      if (!sessionId) {
        const match = rawOutput.match(/thread_id[":]+([0-9a-f-]{36})/);
        if (match) {
          sessionId = match[1];
        }
      }

      if (!sessionId) {
        reject(new Error(`Could not extract session ID from ${label} output`));
        return;
      }

      resolve({
        sessionId,
        output: finalMessage || rawOutput,
      });
    });
  });
}

function sendResponse(id, result) {
  const response = {
    jsonrpc: "2.0",
    id,
    result,
  };
  console.log(JSON.stringify(response));
}

function sendError(id, code, message) {
  const response = {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  };
  console.log(JSON.stringify(response));
}

// Clean shutdown
process.on("SIGINT", () => {
  process.exit();
});

process.on("SIGTERM", () => {
  process.exit();
});
