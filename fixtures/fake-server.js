'use strict';

// Tiny MCP stdio server used by tests and the live example.
// MCP_PREFLIGHT_FIXTURE selects a behavior: default, paginate, chatty, hang.

const fs = require('node:fs');
const readline = require('node:readline');

const mode = process.env.MCP_PREFLIGHT_FIXTURE || 'default';

if (process.env.MCP_PREFLIGHT_LOG) {
  fs.appendFileSync(process.env.MCP_PREFLIGHT_LOG, '');
}

if (mode === 'hang') {
  if (process.env.HANG_PIDFILE) fs.writeFileSync(process.env.HANG_PIDFILE, String(process.pid));
  process.stdin.resume();
  setInterval(() => {}, 1000);
  return;
}

const getNote = {
  name: 'get_note',
  description: 'Read a note by id',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Note id' } },
    required: ['id'],
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
};

const deleteNote = {
  name: 'delete_note',
  description: 'Permanently delete a note',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Note id' } },
    required: ['id'],
  },
};

process.stderr.write('ready\n');

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (process.env.MCP_PREFLIGHT_LOG && msg.method) {
    fs.appendFileSync(process.env.MCP_PREFLIGHT_LOG, `${msg.method}\n`);
  }
  if (msg.method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'fake', version: '0.0.0' },
      },
    });
    return;
  }
  if (msg.method === 'notifications/initialized' && mode === 'chatty') {
    write({ jsonrpc: '2.0', id: 99, method: 'roots/list' });
    return;
  }
  if (msg.method === 'tools/list') {
    if (mode === 'paginate') {
      const cursor = msg.params && msg.params.cursor;
      if (cursor === 'p2') write({ jsonrpc: '2.0', id: msg.id, result: { tools: [deleteNote] } });
      else write({ jsonrpc: '2.0', id: msg.id, result: { tools: [getNote], nextCursor: 'p2' } });
      return;
    }
    write({ jsonrpc: '2.0', id: msg.id, result: { tools: [getNote, deleteNote] } });
    return;
  }
  if (msg.id !== undefined && msg.method) {
    write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
});

function write(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}
