'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { redactText } = require('./text');

const SAFE_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'WINDIR',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'SHELL',
];

const PROTOCOL_VERSION = '2025-11-25';

// Speak just enough of MCP over stdio to list tools:
// initialize, notifications/initialized, then tools/list (following cursors).
// The child is killed when the probe finishes or the timeout fires.
async function probeServer(server, options) {
  const timeoutMs = options.timeoutMs;
  const cwd = resolveCwd(server, options);
  if (!fs.existsSync(cwd)) {
    return { ok: false, reason: `Working directory does not exist: ${cwd}` };
  }

  let child;
  try {
    child = spawn(server.command, server.args || [], {
      cwd,
      env: buildEnv(server),
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    return { ok: false, reason: `Could not start process: ${err.message}` };
  }

  let stderr = '';
  let spawnError = null;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    if (stderr.length < 4000) stderr += chunk;
  });
  child.stdin.on('error', () => {});
  child.stdout.on('error', () => {});
  child.stderr.on('error', () => {});
  child.once('error', (err) => {
    spawnError = err;
  });

  const reader = createReader(child.stdout);
  const pending = new Map();
  let nextId = 1;
  let stop = false;

  const readLoop = (async () => {
    while (!stop) {
      const line = await reader.next();
      if (line == null) break;
      const trimmed = String(line).trim();
      if (!trimmed) continue;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!msg || typeof msg !== 'object') continue;
      const isResponse = Object.prototype.hasOwnProperty.call(msg, 'result') ||
        Object.prototype.hasOwnProperty.call(msg, 'error');
      if (msg.method && Object.prototype.hasOwnProperty.call(msg, 'id') && !isResponse) {
        try {
          child.stdin.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32601, message: 'Method not found' },
            }) + '\n'
          );
        } catch {
          // The process is already going away.
        }
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(msg, 'id')) {
        const waiter = pending.get(String(msg.id));
        if (waiter) {
          pending.delete(String(msg.id));
          waiter(msg);
        }
      }
    }
    for (const waiter of pending.values()) waiter(null);
    pending.clear();
  })();

  const deadline = Date.now() + timeoutMs;

  function request(method, params) {
    if (spawnError) return Promise.reject(spawnError);
    const id = nextId;
    nextId += 1;
    const payload = { jsonrpc: '2.0', id, method };
    if (params !== undefined) payload.params = params;
    try {
      child.stdin.write(JSON.stringify(payload) + '\n');
    } catch (err) {
      return Promise.reject(err);
    }
    const left = deadline - Date.now();
    if (left <= 0) return Promise.reject(Object.assign(new Error('timeout'), { code: 'timeout' }));
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        pending.delete(String(id));
        reject(Object.assign(new Error('timeout'), { code: 'timeout' }));
      }, left);
      pending.set(String(id), (msg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!msg) {
          const code = child.exitCode;
          reject(new Error(code == null ? 'connection closed' : `process exited with code ${code}`));
          return;
        }
        if (msg.error) reject(new Error(msg.error.message || 'RPC error'));
        else resolve(msg.result || {});
      });
    });
  }

  let result;
  try {
    await new Promise((resolve) => setImmediate(resolve));
    if (spawnError) throw spawnError;
    await request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'mcp-preflight', version: options.version || '0.0.0' },
    });
    try {
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'
      );
    } catch (err) {
      throw err;
    }
    const tools = [];
    let cursor;
    const seen = new Set();
    for (let page = 0; page < 50; page += 1) {
      const body = await request('tools/list', cursor ? { cursor } : {});
      if (body.tools && !Array.isArray(body.tools)) {
        throw new Error('tools/list result did not include a tools array');
      }
      if (Array.isArray(body.tools)) {
        for (const tool of body.tools) {
          tools.push(tool);
          if (tools.length >= 500) break;
        }
      }
      if (tools.length >= 500) break;
      if (!body.nextCursor || seen.has(body.nextCursor)) break;
      seen.add(body.nextCursor);
      cursor = body.nextCursor;
    }
    result = { ok: true, tools };
  } catch (err) {
    result = { ok: false, reason: failReason(err, stderr, timeoutMs) };
  } finally {
    stop = true;
    reader.close();
    await killChild(child);
    await readLoop.catch(() => {});
  }
  return result;
}

function failReason(err, stderr, timeoutMs) {
  const timedOut = err.code === 'timeout' || err.message === 'timeout';
  let reason = timedOut
    ? `Timed out after ${timeoutMs}ms waiting for tools/list.`
    : `Live probe failed: ${err.message}`;
  if (!timedOut && stderr.trim()) {
    const extra = redactText(stderr.trim().split('\n').slice(-3).join(' ')).slice(0, 240);
    if (extra) reason += ` stderr: ${extra}`;
  }
  return reason;
}

function resolveCwd(server, options) {
  let cwd = server.cwd || options.cwd;
  cwd = String(cwd)
    .replaceAll('${workspaceFolder}', options.cwd)
    .replaceAll('${userHome}', options.home);
  if (cwd === '~') cwd = options.home;
  else if (cwd.startsWith('~/')) cwd = path.join(options.home, cwd.slice(2));
  if (!path.isAbsolute(cwd)) cwd = path.resolve(options.cwd, cwd);
  return cwd;
}

function buildEnv(server) {
  const env = {};
  for (const key of SAFE_KEYS) {
    if (process.env[key] != null) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(server.env || {})) {
    env[key] = resolveRefs(String(value));
  }
  return env;
}

function resolveRefs(value) {
  return value.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, (full, name) => {
    if (name === 'userHome' || name === 'workspaceFolder' || name === 'workspaceFolderBasename' || name === 'pathSeparator') {
      return full;
    }
    return process.env[name] ?? '';
  });
}

function createReader(stream) {
  let buf = '';
  const lines = [];
  const waiters = [];
  let ended = false;

  const push = (line) => {
    if (waiters.length) waiters.shift()(line);
    else lines.push(line);
  };
  const finish = () => {
    if (ended) return;
    ended = true;
    if (buf) {
      push(buf);
      buf = '';
    }
    while (waiters.length) waiters.shift()(null);
  };

  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    if (buf.length > 5_000_000) {
      buf = '';
      push('');
      finish();
      return;
    }
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      push(line);
    }
  });
  stream.on('end', finish);
  stream.on('close', finish);
  stream.on('error', finish);

  return {
    next() {
      if (lines.length) return Promise.resolve(lines.shift());
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {
      finish();
      stream.destroy();
    },
  };
}

async function killChild(child) {
  if (!child || !child.pid) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  try {
    if (process.platform !== 'win32') process.kill(-pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
  }
  await waitExit(child, 300);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      if (process.platform !== 'win32') process.kill(-pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }
    await waitExit(child, 300);
  }
}

function waitExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

module.exports = {
  probeServer,
  PROTOCOL_VERSION,
};
