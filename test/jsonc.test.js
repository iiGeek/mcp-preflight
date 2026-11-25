'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseJsonc } = require('../lib/jsonc');

describe('parseJsonc', () => {
  it('keeps comment-looking text inside strings and drops real comments', () => {
    const parsed = parseJsonc(`{
      // leading
      "url": "http://example.com//mcp",
      /* block */
      "keep": "value,}",
      "n": 1,
    }`);
    assert.equal(parsed.error, null);
    assert.deepEqual(parsed.data, {
      url: 'http://example.com//mcp',
      keep: 'value,}',
      n: 1,
    });
  });

  it('strips a leading BOM and trailing commas in arrays', () => {
    const parsed = parseJsonc('\uFEFF{ "args": ["-y", "pkg",], }');
    assert.equal(parsed.error, null);
    assert.deepEqual(parsed.data.args, ['-y', 'pkg']);
  });

  it('returns a parse error for broken JSON', () => {
    const parsed = parseJsonc('{');
    assert.equal(parsed.data, null);
    assert.ok(parsed.error);
  });
});
