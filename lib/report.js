'use strict';

const { displayPath } = require('./paths');
const { redactText } = require('./text');

const RANK = { info: 0, low: 1, medium: 2, high: 3 };

function formatReport(result, options = {}) {
  const minimum = options.severity || 'info';
  const color = Boolean(options.color);
  const show = (filePath) => displayPath(filePath, result.cwd, result.home);
  const lines = [];
  lines.push(`mcp-preflight ${result.version}`);
  lines.push('');
  lines.push('Configs');
  if (!result.configs.length) lines.push('  none');
  for (const cfg of result.configs) {
    const err = cfg.error ? `  (${truncate(cfg.error, 72)})` : '';
    lines.push(`  ${pad(cfg.client, 16)} ${show(cfg.path)}${err}`);
  }
  lines.push('');
  lines.push('Servers');
  if (!result.servers.length) lines.push('  none');
  for (const server of result.servers) {
    lines.push(`  ${pad(server.name, 16)} ${pad(server.transport, 6)} ${serverLine(server)}`);
    const where = [show(server.configPath)];
    if (server.projectPath) where.push(`project ${show(server.projectPath)}`);
    lines.push(`  ${blank(16)} ${where.join('  ')}`);
    if (server.live && server.live.status === 'ok') {
      const trunc = server.live.truncated ? ', truncated' : '';
      lines.push(
        `  ${blank(16)} live: ${server.live.toolCount} tools, about ${server.live.estimatedTokens} tokens${trunc}`
      );
    } else if (server.live && server.live.status === 'failed') {
      lines.push(`  ${blank(16)} live failed: ${truncate(server.live.reason, 110)}`);
    }
  }
  lines.push('');
  lines.push('Skills');
  if (!result.skills.length) lines.push('  none');
  for (const skill of result.skills) {
    lines.push(`  ${pad(skill.name, 16)} ${show(skill.path)}`);
  }
  lines.push('');
  lines.push('Findings');
  const visible = result.findings.filter((finding) => rank(finding.severity) >= rank(minimum));
  if (!visible.length) lines.push('  none');
  visible.forEach((finding, index) => {
    const sev = paint(pad(finding.severity, 6), finding.severity, color);
    lines.push(`${sev} ${pad(finding.rule, 22)} ${finding.target}`);
    lines.push(`  ${redactText(finding.message)}`);
    const loc = [show(finding.configPath), finding.location].filter(Boolean).join('  ');
    if (loc) lines.push(`  ${loc}`);
    if (index !== visible.length - 1) lines.push('');
  });
  lines.push('');
  lines.push('Summary');
  const summary = result.summary;
  lines.push(
    `  ${count(summary.configs, 'config')}, ${count(summary.servers, 'server')}, ${count(summary.skills, 'skill')}`
  );
  lines.push(`  ${summary.high} high, ${summary.medium} medium, ${summary.low} low`);
  return `${lines.join('\n')}\n`;
}

function formatJson(result, severity) {
  const minimum = severity || 'info';
  const body = {
    tool: 'mcp-preflight',
    version: result.version,
    cwd: result.cwd,
    configs: result.configs.map((cfg) => ({
      client: cfg.client,
      path: cfg.path,
      scope: cfg.scope,
      error: cfg.error,
    })),
    servers: result.servers.map((server) => ({
      name: server.name,
      client: server.client,
      config: server.configPath,
      scope: server.scope,
      project: server.projectPath,
      transport: server.transport,
      command: server.command,
      args: (server.args || []).map((arg) => redactText(arg)),
      url: server.url ? redactText(server.url) : null,
      disabled: Boolean(server.disabled),
      live: server.live || null,
    })),
    skills: result.skills.map((skill) => ({
      name: skill.name,
      path: skill.path,
      bytes: skill.bytes,
      characters: skill.characters,
    })),
    findings: result.findings
      .filter((finding) => rank(finding.severity) >= rank(minimum))
      .map((finding) => ({
        rule: finding.rule,
        severity: finding.severity,
        target: finding.target,
        targetKind: finding.targetKind,
        config: finding.configPath,
        message: redactText(finding.message),
        location: finding.location,
      })),
    summary: result.summary,
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

function serverLine(server) {
  const disabled = server.disabled ? '  disabled' : '';
  let how;
  if (server.command) {
    how = [server.command, ...(server.args || [])].map((arg) => formatArg(redactText(arg))).join(' ');
  } else {
    how = redactText(server.url || server.transport || '');
  }
  return `${truncate(how, 96)}${disabled}`;
}

function formatArg(arg) {
  const text = String(arg);
  if (text === '') return "''";
  if (/[\s"'$\\]/.test(text)) return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return text;
}

function pad(value, width) {
  const text = String(value ?? '');
  return text.length >= width ? text : text.padEnd(width);
}

function blank(width) {
  return ' '.repeat(width);
}

function truncate(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function paint(text, severity, color) {
  if (!color) return text;
  const codes = { high: '31', medium: '33', low: '36' };
  const code = codes[severity];
  if (!code) return text;
  return `\u001b[${code}m${text}\u001b[0m`;
}

function rank(severity) {
  return RANK[severity] ?? 0;
}

function count(n, singular) {
  return `${n} ${n === 1 ? singular : `${singular}s`}`;
}

module.exports = {
  formatReport,
  formatJson,
  rank,
};
