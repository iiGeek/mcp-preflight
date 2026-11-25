'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { probeServer } = require('../lib/live');
const { audit } = require('../lib/run');

const repo = path.join(__dirname, '..');
const fake = path.join(repo, 'fixtures', 'fake-server.js');

function probe(env, timeoutMs = 4000) {
  return probeServer(
    { command: process.execPath, args: [fake], env: env || {}, cwd: null },
    { cwd: repo, home: repo, timeoutMs, version: '0.0.0' }
  );
}

describe('stdio probe', () => {
  it('lists tools after initialize and ignores stderr', async () => {
    const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-preflight-log-')), 'methods');
    const result = await probe({ MCP_PREFLIGHT_LOG: log });
    assert.equal(result.ok, true);
    assert.deepEqual(result.tools.map((tool) => tool.name), ['get_note', 'delete_note']);
    assert.equal(fs.readFileSync(log, 'utf8'), 'initialize\nnotifications/initialized\ntools/list\n');
  });

  it('follows a nextCursor', async () => {
    const result = await probe({ MCP_PREFLIGHT_FIXTURE: 'paginate' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.tools.map((tool) => tool.name), ['get_note', 'delete_note']);
  });

  it('answers a server request during the handshake', async () => {
    const result = await probe({ MCP_PREFLIGHT_FIXTURE: 'chatty' });
    assert.equal(result.ok, true);
    assert.equal(result.tools.length, 2);
  });

  it('times out and kills a server that never answers', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-preflight-hang-'));
    const pidfile = path.join(dir, 'pid');
    const result = await probe({ MCP_PREFLIGHT_FIXTURE: 'hang', HANG_PIDFILE: pidfile }, 400);
    assert.equal(result.ok, false);
    assert.match(result.reason, /Timed out after 400ms/);
    const pid = Number(fs.readFileSync(pidfile, 'utf8'));
    assert.throws(() => process.kill(pid, 0));
  });

  it('reports a command that cannot be started', async () => {
    const result = await probeServer(
      { command: 'mcp-preflight-missing-bin', args: [], env: {} },
      { cwd: repo, home: repo, timeoutMs: 1000, version: '0.0.0' }
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /Live probe failed/);
  });

  it('attaches tool findings through the audit API', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-preflight-home-'));
    const result = await audit({
      cwd: repo,
      home,
      only: true,
      live: true,
      timeoutMs: 4000,
      configs: [path.join(repo, 'fixtures', 'live', 'mcp.json')],
    });
    assert.equal(result.summary.high, 0);
    assert.equal(result.servers[0].live.status, 'ok');
    assert.equal(result.servers[0].live.toolCount, 2);
    assert.ok(result.servers[0].live.estimatedTokens > 0);
    const rules = result.findings.map((finding) => finding.rule).sort();
    assert.deepEqual(rules, ['destructive-tool', 'missing-annotation']);
  });
});
