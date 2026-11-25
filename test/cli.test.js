'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repo = path.join(__dirname, '..');
const bin = path.join(repo, 'bin', 'mcp-preflight.js');

function run(args) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    cwd: repo,
    timeout: 15000,
    env: { ...process.env, NO_COLOR: '1' },
  });
}

describe('cli', () => {
  it('prints help and version', () => {
    const help = run(['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--live/);
    assert.match(help.stdout, /--json/);
    assert.match(help.stdout, /Exit codes/);

    const version = run(['--version']);
    assert.equal(version.status, 0);
    assert.equal(version.stdout.trim(), require('../package.json').version);
  });

  it('exits 2 for a missing config and for --only with no paths', () => {
    const missing = run(['--config', 'fixtures/does-not-exist.json', '--only']);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /Config not found/);

    const empty = run(['--only']);
    assert.equal(empty.status, 2);
    assert.match(empty.stderr, /--only/);
  });

  it('exits 0 for the clean fixture and does not read the real home', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-preflight-clean-'));
    const result = run(['--cwd', 'fixtures/clean', '--home', home, '--no-color']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /0 high, 0 medium, 0 low/);
    assert.match(result.stdout, /notes/);
  });

  it('exits 1 for the example project and redacts the fixture secret', () => {
    const result = run([
      '--cwd',
      'fixtures/example',
      '--home',
      'fixtures/example/home',
      '--json',
    ]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout.includes('sk-test'), false);
    const body = JSON.parse(result.stdout);
    assert.equal(body.tool, 'mcp-preflight');
    assert.equal(body.summary.high, 7);
    assert.equal(body.summary.medium, 3);
    assert.equal(body.summary.low, 1);
    assert.equal(body.summary.ok, false);
    assert.equal(body.servers.every((server) => server.env === undefined), true);
    assert.equal(body.findings.some((finding) => finding.rule === 'inline-secret'), true);
  });

  it('keeps the README examples equal to a fresh run', () => {
    const readme = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
    const blocks = [...readme.matchAll(/```text\n([\s\S]*?)```/g)].map((match) => match[1]);
    assert.equal(blocks.length, 2);

    const example = run([
      '--cwd',
      'fixtures/example',
      '--home',
      'fixtures/example/home',
      '--no-color',
    ]);
    assert.equal(example.status, 1);
    assert.equal(example.stdout, blocks[0]);

    const live = run(['--only', '--config', 'fixtures/live/mcp.json', '--live', '--no-color']);
    assert.equal(live.status, 0);
    assert.equal(live.stdout, blocks[1]);
  });

  it('accepts the shipped skill without findings', () => {
    const result = run(['--only', '--skills', 'skill/SKILL.md', '--no-color']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /0 high, 0 medium, 0 low/);
  });
});
