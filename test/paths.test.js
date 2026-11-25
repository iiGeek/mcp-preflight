'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { displayPath } = require('../lib/paths');

describe('displayPath', () => {
  it('keeps a project path relative when the project is inside home', () => {
    const home = '/home/runner';
    const cwd = '/home/runner/work/mcp-preflight/mcp-preflight';
    const file = `${cwd}/fixtures/live/mcp.json`;
    assert.equal(displayPath(file, cwd, home), 'fixtures/live/mcp.json');
    assert.equal(displayPath(`${home}/.claude.json`, cwd, home), '~/.claude.json');
  });
});
