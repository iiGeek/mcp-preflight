'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SKIP = new Set(['.git', 'node_modules']);

function assertNoCursorDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (!entry.isDirectory()) continue;
    assert.notEqual(entry.name, '.cursor', full);
    assertNoCursorDir(full);
  }
}

function filesUnder(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) filesUnder(full, out);
    else if (/\.(?:js|md|json|yml|toml)$/.test(entry.name) || entry.name === 'LICENSE') out.push(full);
  }
  return out;
}

describe('repo style', () => {
  it('does not commit a .cursor directory', () => {
    assertNoCursorDir(path.join(__dirname, '..'));
  });

  it('has no emoji and no generated-by notes in source files', () => {
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
    const banned = 'generated' + ' by';
    const files = filesUnder(path.join(__dirname, '..'), []);
    assert.ok(files.length > 10);
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      assert.equal(emoji.test(text), false, file);
      assert.equal(text.toLowerCase().includes(banned), false, file);
    }
  });
});
