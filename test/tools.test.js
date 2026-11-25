'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { analyzeTools, toolFindings } = require('../lib/tools');
const { estimateTokens } = require('../lib/tokens');

describe('tool analysis', () => {
  it('sums the per-tool character estimate and classifies hints', () => {
    const read = {
      name: 'get_note',
      description: 'Read a note',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true, destructiveHint: false },
    };
    const named = {
      name: 'delete_note',
      description: 'Remove one note',
      inputSchema: { type: 'object' },
    };
    const described = {
      name: 'page',
      description: 'Permanently delete a page',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: false },
    };
    const mismatch = {
      name: 'delete_page',
      description: 'Fetch a page',
      annotations: { readOnlyHint: true, destructiveHint: false },
    };
    const analysis = analyzeTools([read, named, described, mismatch]);
    assert.equal(
      analysis.estimatedTokens,
      [read, named, described, mismatch].reduce((sum, tool) => sum + estimateTokens(tool), 0)
    );
    const findings = toolFindings({ name: 'demo', configPath: '/cfg' }, analysis);
    const byRule = Object.fromEntries(findings.map((finding) => [finding.rule, finding]));
    assert.match(byRule['missing-annotation'].message, /delete_note \(readOnlyHint, destructiveHint\)/);
    assert.match(byRule['missing-annotation'].message, /page \(destructiveHint\)/);
    assert.match(byRule['destructive-tool'].message, /delete_note \(name\)/);
    assert.match(byRule['destructive-tool'].message, /page \(description\)/);
    assert.match(byRule['annotation-mismatch'].message, /delete_page/);
    assert.equal(byRule['destructive-tool'].message.includes('get_note'), false);
  });

  it('does not treat a negated description as destructive', () => {
    const analysis = analyzeTools([
      {
        name: 'save_note',
        description: 'Save a note. This does not permanently delete anything.',
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
    ]);
    assert.deepEqual(analysis.destructive, []);
    assert.deepEqual(analysis.missing, []);
  });
});
