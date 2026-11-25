'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { splitArgs } = require('./args');
const { parseJsonc } = require('./jsonc');
const { parseMcpServers } = require('./toml');

function loadConfigFile(filePath, meta) {
  const abs = path.resolve(filePath);
  const info = {
    client: meta.client,
    path: abs,
    scope: meta.scope || 'project',
    explicit: Boolean(meta.explicit),
  };
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    return {
      include: true,
      error: err.message,
      servers: [],
      findings: [fileFinding(info, `Could not read config: ${err.message}`)],
    };
  }

  if (isToml(abs, info.client)) {
    return fromToml(text, info);
  }
  const parsed = parseJsonc(text);
  if (parsed.error) {
    return {
      include: true,
      error: parsed.error,
      servers: [],
      findings: [fileFinding(info, `Invalid JSON: ${parsed.error}`)],
    };
  }
  return fromJson(parsed.data, info);
}

function isToml(filePath, client) {
  if (client === 'codex') return true;
  return filePath.toLowerCase().endsWith('.toml');
}

function isDedicated(filePath) {
  const base = path.basename(filePath);
  return (
    base === 'mcp.json' ||
    base === '.mcp.json' ||
    base === 'mcp_config.json' ||
    base === 'claude_desktop_config.json'
  );
}

function fromToml(text, info) {
  const parsed = parseMcpServers(text);
  const findings = [];
  const servers = [];
  if (parsed.errors.length) {
    findings.push(fileFinding(info, `Could not read part of the TOML: ${parsed.errors[0]}`));
  }
  readGroup(parsed.servers, info, 'mcp_servers', servers, findings);
  const include = info.explicit || servers.length > 0 || findings.length > 0;
  return { include, error: parsed.errors[0] || null, servers, findings };
}

function fromJson(data, info) {
  const findings = [];
  const servers = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {
      include: true,
      error: 'Config root is not an object',
      servers,
      findings: [fileFinding(info, 'Config root is not an object.')],
    };
  }

  if (data.mcpServers !== undefined) {
    readGroup(data.mcpServers, { ...info }, 'mcpServers', servers, findings);
  }
  if (data.servers !== undefined && (isDedicated(info.path) || looksLikeServerMap(data.servers))) {
    readGroup(data.servers, { ...info }, 'servers', servers, findings);
  }
  if (data.projects && typeof data.projects === 'object' && !Array.isArray(data.projects)) {
    for (const [projectPath, project] of Object.entries(data.projects)) {
      if (!project || typeof project !== 'object' || project.mcpServers === undefined) continue;
      readGroup(
        project.mcpServers,
        { ...info, scope: 'local', projectPath },
        'mcpServers',
        servers,
        findings
      );
    }
  }

  const include = info.explicit || isDedicated(info.path) || servers.length > 0 || findings.length > 0;
  return { include, error: null, servers, findings };
}

function readGroup(value, info, label, servers, findings) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    findings.push(fileFinding(info, `${label} is not an object.`));
    return;
  }
  for (const [name, entry] of Object.entries(value)) {
    const built = buildServer(name, entry, info);
    if (built.finding) findings.push(built.finding);
    if (built.server) servers.push(built.server);
  }
}

function looksLikeServerMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const values = Object.values(value);
  if (!values.length) return false;
  return values.every(
    (entry) =>
      entry &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      (typeof entry.command === 'string' ||
        typeof entry.url === 'string' ||
        entry.args != null ||
        typeof entry.type === 'string' ||
        typeof entry.transport === 'string')
  );
}

function buildServer(name, entry, info) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return {
      finding: finding(info, name, 'config-invalid', 'medium', `Server "${name}" is not an object.`),
    };
  }

  let args = [];
  let argsFinding = null;
  if (entry.args == null) args = [];
  else if (typeof entry.args === 'string') args = splitArgs(entry.args);
  else if (Array.isArray(entry.args)) args = entry.args.flat(1).map((value) => String(value));
  else {
    argsFinding = finding(info, name, 'config-invalid', 'medium', `Server "${name}" has args that are not a string or an array.`, 'args');
  }

  const command = typeof entry.command === 'string' ? entry.command : null;
  const url = typeof entry.url === 'string' ? entry.url : null;
  const typeRaw = String(entry.type || entry.transport || '').toLowerCase();
  let transport = 'stdio';
  if (typeRaw === 'sse') transport = 'sse';
  else if (typeRaw === 'ws' || typeRaw === 'websocket') transport = 'ws';
  else if (typeRaw === 'http' || typeRaw === 'streamable-http') transport = 'http';
  else if (url && !command) transport = 'http';

  const server = {
    name: String(name),
    client: info.client,
    configPath: info.path,
    scope: info.scope || 'project',
    projectPath: info.projectPath || null,
    transport,
    command,
    args,
    env: normalizeMap(entry.env),
    headers: {
      ...normalizeMap(entry.headers),
      ...normalizeMap(entry.http_headers),
      ...normalizeMap(entry.httpHeaders),
    },
    envHttpHeaders: normalizeMap(entry.env_http_headers || entry.envHttpHeaders),
    url,
    cwd: typeof entry.cwd === 'string' ? entry.cwd : null,
    disabled: entry.disabled === true || entry.enabled === false,
    bearerToken: typeof entry.bearer_token === 'string' ? entry.bearer_token : null,
    bearerTokenEnvVar:
      typeof entry.bearer_token_env_var === 'string' ? entry.bearer_token_env_var : null,
    ambiguous: Boolean(url && command),
    missingType: Boolean(url && !command && !typeRaw),
  };

  return { server, finding: argsFinding };
}

function normalizeMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw == null) continue;
    out[key] = typeof raw === 'string' ? raw : String(raw);
  }
  return out;
}

function fileFinding(info, message) {
  return finding(info, path.basename(info.path), 'config-invalid', 'medium', message);
}

function finding(info, target, rule, severity, message, location) {
  return {
    rule,
    severity,
    target,
    targetKind: 'config',
    configPath: info.path,
    message,
    location: location || null,
  };
}

function guessClient(filePath) {
  const p = String(filePath).replace(/\\/g, '/').toLowerCase();
  const base = path.posix.basename(p);
  if (base === 'claude_desktop_config.json') return 'claude-desktop';
  if (base === '.claude.json') return 'claude-code';
  if (base === '.mcp.json') return 'claude-code';
  if (p.includes('/.cursor/')) return 'cursor';
  if (p.includes('/.vscode/') || p.includes('/code/user/mcp.json')) return 'vscode';
  if (p.includes('/windsurf/') || p.includes('/.windsurf/')) return 'windsurf';
  if (base === 'config.toml' || p.includes('/.codex/')) return 'codex';
  return 'file';
}

module.exports = {
  loadConfigFile,
  guessClient,
};
