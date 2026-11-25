'use strict';

const { estimateTokens } = require('./tokens');

const DESTRUCTIVE = new Set([
  'delete',
  'destroy',
  'drop',
  'wipe',
  'truncate',
  'purge',
  'erase',
  'overwrite',
  'unlink',
  'revoke',
  'kill',
  'shutdown',
  'exec',
  'shell',
]);

const DESC = [
  /permanently delete/i,
  /delete all\b/i,
  /drop (?:the )?(?:table|database|schema|collection)/i,
  /\bwipe\b/i,
  /\boverwrite\b/i,
  /rm\s+-rf/i,
  /arbitrary (?:command|code|shell)/i,
  /(?:run|spawn|execute) (?:a |an )?(?:shell|command|subprocess)/i,
];

function analyzeTools(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const summarized = [];
  const missing = [];
  const destructive = [];
  const mismatch = [];
  let estimatedTokens = 0;
  const capped = list.slice(0, 500);
  for (const tool of capped) {
    if (!tool || typeof tool !== 'object') continue;
    const name = typeof tool.name === 'string' && tool.name ? tool.name : '(unnamed)';
    const tokens = estimateTokens(tool);
    estimatedTokens += tokens;
    const ann = tool.annotations && typeof tool.annotations === 'object' ? tool.annotations : {};
    const hasRead = typeof ann.readOnlyHint === 'boolean';
    const hasDest = typeof ann.destructiveHint === 'boolean';
    const readOnly = ann.readOnlyHint === true;
    const bits = [];
    if (!hasRead) bits.push('readOnlyHint');
    if (!readOnly && !hasDest) bits.push('destructiveHint');
    if (bits.length) missing.push(`${name} (${bits.join(', ')})`);
    const nameHit = destructiveName(name);
    const descHit = destructiveDescription(tool.description);
    if (nameHit && readOnly) mismatch.push(name);
    else if ((nameHit || descHit) && !readOnly) {
      destructive.push(nameHit ? `${name} (name)` : `${name} (description)`);
    }
    summarized.push({
      name,
      estimatedTokens: tokens,
      readOnlyHint: hasRead ? ann.readOnlyHint : null,
      destructiveHint: hasDest ? ann.destructiveHint : null,
    });
  }
  return {
    toolCount: summarized.length,
    estimatedTokens,
    tools: summarized,
    missing,
    destructive,
    mismatch,
    truncated: list.length > capped.length,
  };
}

function toolFindings(server, analysis) {
  const out = [];
  if (analysis.missing.length) {
    const shown = analysis.missing.slice(0, 8);
    const more =
      analysis.missing.length > shown.length
        ? `, and ${analysis.missing.length - shown.length} more`
        : '';
    out.push(
      liveFinding(
        server,
        'missing-annotation',
        'medium',
        `Tools missing annotations: ${shown.join(', ')}${more}. A missing readOnlyHint defaults to false and a missing destructiveHint defaults to true, so clients treat the tool as a destructive write. Annotations are hints, not enforcement.`
      )
    );
  }
  if (analysis.destructive.length) {
    out.push(
      liveFinding(
        server,
        'destructive-tool',
        'medium',
        `Tools whose name or description suggests a destructive action, without readOnlyHint true: ${analysis.destructive.slice(0, 8).join(', ')}.`
      )
    );
  }
  if (analysis.mismatch.length) {
    out.push(
      liveFinding(
        server,
        'annotation-mismatch',
        'medium',
        `Tools marked readOnlyHint true but named like a destructive action: ${analysis.mismatch.slice(0, 8).join(', ')}. Annotations are hints and are not verified.`
      )
    );
  }
  return out;
}

function destructiveName(name) {
  return String(name)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .some((part) => DESTRUCTIVE.has(part));
}

function destructiveDescription(description) {
  if (!description || typeof description !== 'string') return false;
  return description.split(/[.\n]/).some((sentence) => {
    if (/\b(?:do not|don't|never|won't|will not|does not|doesn't)\b/i.test(sentence)) return false;
    return DESC.some((re) => re.test(sentence));
  });
}

function liveFinding(server, rule, severity, message) {
  return {
    rule,
    severity,
    target: server.name,
    targetKind: 'server',
    configPath: server.configPath,
    message,
    location: 'tools/list',
  };
}

module.exports = {
  analyzeTools,
  toolFindings,
};
