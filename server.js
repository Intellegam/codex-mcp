#!/usr/bin/env node

/**
 * Codex CLI-based MCP Server
 *
 * Acts as an MCP server but uses Codex CLI internally.
 * This gives us session IDs reliably from JSON output!
 */

const { spawn } = require('child_process');
const readline = require('readline');

// MCP protocol uses JSON-RPC over stdio
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

// Store active sessions: sessionId -> {prompt, created}
const sessions = new Map();

// Handle incoming JSON-RPC messages
rl.on('line', async (line) => {
  try {
    const message = JSON.parse(line);

    // Route different MCP methods
    switch (message.method) {
      case 'initialize':
        handleInitialize(message);
        break;

      case 'initialized':
        // Client confirming initialization
        break;

      case 'tools/list':
        handleToolsList(message);
        break;

      case 'tools/call':
        await handleToolCall(message);
        break;

      default:
        sendError(message.id, -32601, 'Method not found');
    }
  } catch (e) {
    console.error('Error processing message:', e);
  }
});

function handleInitialize(message) {
  sendResponse(message.id, {
    protocolVersion: '2024-11-05',
    capabilities: {
      tools: {},
      resources: {}
    },
    serverInfo: {
      name: 'codex-cli-wrapper',
      version: '1.0.0'
    }
  });
}

function handleToolsList(message) {
  sendResponse(message.id, {
    tools: [
      {
        name: 'codex',
        description: 'Start a new Codex session',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'The prompt for Codex' },
            sandbox: {
              type: 'string',
              enum: ['read-only', 'workspace-write', 'danger-full-access'],
              description: 'Sandbox mode'
            },
            'approval-policy': {
              type: 'string',
              enum: ['untrusted', 'on-failure', 'on-request', 'never'],
              description: 'Approval policy'
            },
            cwd: { type: 'string', description: 'Working directory' },
            model: { type: 'string', description: 'Model override' }
          },
          required: ['prompt']
        }
      },
      {
        name: 'codex-reply',
        description: 'Continue an existing Codex session',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: { type: 'string', description: 'Session ID' },
            prompt: { type: 'string', description: 'Follow-up prompt' }
          },
          required: ['conversationId', 'prompt']
        }
      }
    ]
  });
}

async function handleToolCall(message) {
  const { name, arguments: args } = message.params;

  try {
    if (name === 'codex') {
      const result = await runCodexStart(args);
      sendResponse(message.id, {
        content: [
          { type: 'text', text: result.output },
          { type: 'text', text: `\n[SESSION_ID: ${result.sessionId}]` }
        ]
      });

    } else if (name === 'codex-reply') {
      const result = await runCodexResume(args.conversationId, args.prompt);
      sendResponse(message.id, {
        content: [
          { type: 'text', text: result.output }
        ]
      });

    } else {
      sendError(message.id, -32602, `Unknown tool: ${name}`);
    }
  } catch (e) {
    sendError(message.id, -32603, e.message);
  }
}

function runCodexStart(args) {
  return new Promise((resolve, reject) => {
    // Build CLI command
    const cliArgs = ['exec', args.prompt];

    if (args.sandbox) {
      cliArgs.push('--sandbox', args.sandbox);
    }
    if (args.model) {
      cliArgs.push('-m', args.model);
    }
    if (args.cwd) {
      cliArgs.push('-C', args.cwd);
    }

    // Add JSON flag to get structured output
    cliArgs.push('--json');

    // Spawn Codex CLI
    const proc = spawn('codex', cliArgs, {
      env: process.env,
      cwd: args.cwd || process.cwd()
    });

    let output = '';
    let jsonLines = [];
    let sessionId = null;
    let finalMessage = '';

    proc.stdout.on('data', (data) => {
      output += data.toString();
      const lines = data.toString().split('\n');

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const json = JSON.parse(line);
          jsonLines.push(json);

          // Extract session ID from thread.started event
          if (json.type === 'thread.started' && json.thread_id) {
            sessionId = json.thread_id;
          }

          // Extract final message from agent_message events
          if (json.type === 'item.completed' &&
              json.item?.type === 'agent_message' &&
              json.item?.text) {
            finalMessage = json.item.text;
          }
        } catch (e) {
          // Not JSON, ignore
        }
      }
    });

    proc.stderr.on('data', (data) => {
      console.error('Codex stderr:', data.toString());
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Codex exited with code ${code}`));
      } else if (!sessionId) {
        // Fallback: try to extract from output if JSON parsing failed
        const match = output.match(/thread_id[":]+([0-9a-f-]{36})/);
        if (match) {
          sessionId = match[1];
        }

        if (!sessionId) {
          reject(new Error('Could not extract session ID from Codex output'));
        } else {
          resolve({
            sessionId,
            output: finalMessage || output
          });
        }
      } else {
        // Store session info
        sessions.set(sessionId, {
          created: Date.now(),
          initialPrompt: args.prompt
        });

        resolve({
          sessionId,
          output: finalMessage || output
        });
      }
    });
  });
}

function runCodexResume(sessionId, prompt) {
  return new Promise((resolve, reject) => {
    // Use CLI resume command
    const proc = spawn('codex', [
      'exec', 'resume', sessionId, prompt
    ], {
      env: process.env
    });

    let output = '';

    proc.stdout.on('data', (data) => {
      output += data.toString();
    });

    proc.stderr.on('data', (data) => {
      console.error('Codex stderr:', data.toString());
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Codex resume exited with code ${code}`));
      } else {
        resolve({ output });
      }
    });
  });
}

function sendResponse(id, result) {
  const response = {
    jsonrpc: '2.0',
    id,
    result
  };
  console.log(JSON.stringify(response));
}

function sendError(id, code, message) {
  const response = {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message
    }
  };
  console.log(JSON.stringify(response));
}

// Clean shutdown
process.on('SIGINT', () => {
  process.exit();
});

process.on('SIGTERM', () => {
  process.exit();
});
