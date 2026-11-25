'use strict';

const { splitArgs, splitDetailed } = require('./args');
const { packagesOf } = require('./packages');
const {
  basenameCommand,
  directoryEnvValues,
  displayPath,
  dockerHostPaths,
  isBroadRoot,
  isSymbolicHome,
} = require('./paths');
const {
  SENSITIVE_FLAG,
  hasTokenShape,
  redactText,
  remainder,
  sensitiveLiteral,
  urlHasEmbeddedPassword,
} = require('./text');

const SHELLS = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ash',
  'cmd',
  'powershell',
  'pwsh',
]);

const LAUNCHERS = new Set(['npx', 'bunx', 'uvx', 'pnpm', 'yarn', 'deno']);

function checkServers(servers, ctx) {
  const findings = [];
  for (const server of servers) findings.push(...checkOne(server, ctx));
  findings.push(...duplicateFindings(servers, ctx));
  return findings;
}

function checkOne(server, ctx) {
  return [
    ...secretFindings(server),
    ...broadFindings(server, ctx),
    ...unpinnedFindings(server),
    ...urlFindings(server),
    ...shellFindings(server),
    ...shapeFindings(server),
  ];
}

function secretFindings(server) {
  const out = [];
  for (const [key, value] of Object.entries(server.env || {})) {
    if (sensitiveLiteral(key, value) || urlHasEmbeddedPassword(value)) {
      out.push(
        make(
          server,
          'inline-secret',
          'high',
          `Env ${key} is a literal value. Reference it from the environment instead, for example \${${key}}.`,
          `env.${key}`
        )
      );
    }
  }
  for (const [key, value] of Object.entries(server.headers || {})) {
    if (sensitiveLiteral(key, value) || hasTokenShape(value)) {
      out.push(
        make(
          server,
          'inline-secret',
          'high',
          `Header ${key} is a literal value. Reference it from the environment instead, for example \${${headerEnvName(key)}}.`,
          `headers.${key}`
        )
      );
    }
  }
  for (const [key, value] of Object.entries(server.envHttpHeaders || {})) {
    if (hasTokenShape(value)) {
      out.push(
        make(
          server,
          'inline-secret',
          'high',
          `env_http_headers.${key} looks like a token. That field is the name of an environment variable, not the secret itself.`,
          `env_http_headers.${key}`
        )
      );
    }
  }
  if (server.bearerToken && remainder(server.bearerToken)) {
    out.push(
      make(
        server,
        'inline-secret',
        'high',
        'bearer_token is a literal. Use bearer_token_env_var and keep the token in the environment.',
        'bearer_token'
      )
    );
  }
  if (server.bearerTokenEnvVar && hasTokenShape(server.bearerTokenEnvVar)) {
    out.push(
      make(
        server,
        'inline-secret',
        'high',
        'bearer_token_env_var looks like a token. It should be the name of an environment variable.',
        'bearer_token_env_var'
      )
    );
  }
  if (server.url && urlHasEmbeddedPassword(server.url)) {
    out.push(
      make(
        server,
        'inline-secret',
        'high',
        'The server URL contains a password. Pass the credential in a referenced environment variable instead.',
        'url'
      )
    );
  }
  const args = server.args || [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (urlHasEmbeddedPassword(arg) || hasTokenShape(arg)) {
      out.push(
        make(
          server,
          'inline-secret',
          'high',
          `Argument ${i} contains a literal credential.`,
          `args[${i}]`
        )
      );
      continue;
    }
    const eq = arg.match(/^(-{1,2}[A-Za-z0-9][\w-]*)=(.*)$/s);
    if (eq && (sensitiveLiteral(eq[1], eq[2]) || urlHasEmbeddedPassword(eq[2]))) {
      out.push(
        make(
          server,
          'inline-secret',
          'high',
          `Argument ${eq[1]} is a literal value. Reference it from the environment instead.`,
          `args[${i}]`
        )
      );
      continue;
    }
    if (SENSITIVE_FLAG.test(arg) && args[i + 1] != null && sensitiveLiteral(arg, args[i + 1])) {
      out.push(
        make(
          server,
          'inline-secret',
          'high',
          `Argument ${arg} is followed by a literal value. Reference it from the environment instead.`,
          `args[${i + 1}]`
        )
      );
      i += 1;
    }
  }
  return out;
}

function headerEnvName(key) {
  const cleaned = String(key).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toUpperCase();
  return cleaned || 'HEADER';
}

function broadFindings(server, ctx) {
  const hits = [];
  const args = server.args || [];
  args.forEach((arg, index) => {
    const kind = isBroadRoot(arg, ctx.home, ctx.platform);
    if (kind) hits.push({ kind, location: `args[${index}]` });
  });
  for (const host of dockerHostPaths(args)) {
    const kind = isBroadRoot(host, ctx.home, ctx.platform);
    if (kind) hits.push({ kind, location: 'docker mount' });
  }
  for (const entry of directoryEnvValues(server.env, ctx.platform)) {
    const kind = isBroadRoot(entry.value, ctx.home, ctx.platform);
    if (kind) hits.push({ kind, location: `env.${entry.key}` });
  }
  if (server.cwd) {
    const kind = isBroadRoot(server.cwd, ctx.home, ctx.platform);
    if (kind) hits.push({ kind, location: 'cwd' });
  }
  const shell = shellScriptOf(server.command, args);
  if (shell) {
    const detailed = splitDetailed(shell.script);
    const words = detailed.map((word) => word.text);
    detailed.forEach((word) => {
      if (word.quote === "'" && isSymbolicHome(word.text)) return;
      const kind = isBroadRoot(word.text, ctx.home, ctx.platform);
      if (kind) hits.push({ kind, location: 'shell string' });
    });
    for (const host of dockerHostPaths(words)) {
      const kind = isBroadRoot(host, ctx.home, ctx.platform);
      if (kind) hits.push({ kind, location: 'docker mount' });
    }
  }

  const grouped = new Map();
  for (const hit of hits) {
    const list = grouped.get(hit.kind) || [];
    if (!list.includes(hit.location)) list.push(hit.location);
    grouped.set(hit.kind, list);
  }
  const out = [];
  for (const [kind, locations] of grouped) {
    const what = kind === 'root' ? 'the filesystem root' : 'the home directory';
    out.push(
      make(
        server,
        'broad-filesystem',
        'high',
        `Grants access to ${what} via ${locations.join(', ')}. Point the server at a specific project directory instead.`,
        locations[0]
      )
    );
  }
  return out;
}

function unpinnedFindings(server) {
  const specs = packagesOf(server.command, server.args || []);
  const shell = shellScriptOf(server.command, server.args || []);
  if (shell) specs.push(...packagesInScript(shell.script));
  const seen = new Set();
  const out = [];
  for (const spec of specs) {
    if (!spec || spec.pinned) continue;
    const key = `${spec.manager}\0${spec.spec}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(
      make(
        server,
        'unpinned-package',
        'medium',
        `${spec.manager} will launch "${spec.spec}" without a version pin. A bare name or a latest tag can change on the next run.`,
        'args'
      )
    );
  }
  return out;
}

function packagesInScript(script) {
  const words = splitArgs(script);
  const found = [];
  for (let i = 0; i < words.length; i += 1) {
    const base = basenameCommand(words[i]);
    if (!LAUNCHERS.has(base)) continue;
    const rest = [];
    for (let j = i + 1; j < words.length; j += 1) {
      if (/^(?:&&|\|\||[|;])$/.test(words[j])) break;
      rest.push(words[j]);
    }
    found.push(...packagesOf(words[i], rest));
  }
  return found;
}

function urlFindings(server) {
  if (!server.url) return [];
  let parsed;
  try {
    parsed = new URL(server.url);
  } catch {
    return [
      make(server, 'config-invalid', 'medium', `Server URL is not a valid URL.`, 'url'),
    ];
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'ws:') return [];
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback =
    host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
  const shown = redactText(server.url);
  const scheme = parsed.protocol.replace(':', '');
  if (loopback) {
    return [
      make(
        server,
        'loopback-http',
        'low',
        `Loopback URL ${shown} uses cleartext ${scheme}.`,
        'url'
      ),
    ];
  }
  return [
    make(
      server,
      'cleartext-remote',
      'high',
      `Remote URL ${shown} uses cleartext ${scheme}. Traffic to that host is not encrypted.`,
      'url'
    ),
  ];
}

function shellFindings(server) {
  const shell = shellScriptOf(server.command, server.args || []);
  if (!shell) return [];
  const kind = interpolationKind(shell.script, shell.shell);
  if (!kind) return [];
  const how = kind === 'substitution' ? 'command substitution' : 'variable expansion';
  return [
    make(
      server,
      'shell-interpolation',
      'high',
      `${shell.shell} evaluates a shell string with ${how}. Clients normally exec the command directly; a shell evaluates the string.`,
      'args'
    ),
  ];
}

function shellScriptOf(command, args) {
  const base = basenameCommand(command);
  const list = args || [];
  if (base === 'busybox' && list.length && SHELLS.has(basenameCommand(list[0]))) {
    return shellScriptOf(list[0], list.slice(1));
  }
  if (!SHELLS.has(base)) {
    if (typeof command === 'string' && /\s/.test(command)) {
      const parts = splitArgs(command);
      if (parts.length && SHELLS.has(basenameCommand(parts[0]))) {
        return shellScriptOf(parts[0], parts.slice(1).concat(list));
      }
    }
    return null;
  }
  for (let i = 0; i < list.length; i += 1) {
    const token = String(list[i]);
    const low = token.toLowerCase();
    const isScriptFlag =
      low === '--command' || low === '-command' || low === '/c' || /^-[a-zA-Z]*c[a-zA-Z]*$/.test(token);
    if (!isScriptFlag) continue;
    const script = list.slice(i + 1).join(' ');
    return script ? { shell: base, script } : null;
  }
  return null;
}

function interpolationKind(script, shell) {
  if (shell === 'cmd' && /%[^%\s]+%/.test(script)) return 'expansion';
  let quote = null;
  let kind = null;
  for (let i = 0; i < script.length; i += 1) {
    const c = script[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (c === '"') {
        quote = null;
        continue;
      }
    } else {
      if (c === "'") {
        quote = "'";
        continue;
      }
      if (c === '"') {
        quote = '"';
        continue;
      }
    }
    if (c === '`') return 'substitution';
    if (c === '$' && script[i + 1] === '(') return 'substitution';
    if (c === '$' && /[A-Za-z_{]/.test(script[i + 1] || '')) kind = kind || 'expansion';
  }
  if (/\b(?:eval|invoke-expression)\b/i.test(script) || /(^|\s)iex(\s|$)/i.test(script)) {
    return 'substitution';
  }
  return kind;
}

function shapeFindings(server) {
  const out = [];
  if (server.ambiguous) {
    out.push(
      make(
        server,
        'config-ambiguous',
        'low',
        'This entry sets both command and url. Clients disagree on which field wins. Claude Code treats a typeless entry as stdio.'
      )
    );
  }
  if (server.missingType) {
    out.push(
      make(
        server,
        'missing-type',
        'low',
        'This entry has a url and no type. Claude Code skips it. Set type to "http" or "sse".'
      )
    );
  }
  if (!server.command && !server.url) {
    out.push(
      make(server, 'config-invalid', 'medium', `Server "${server.name}" has neither a command nor a url.`)
    );
  }
  return out;
}

function duplicateFindings(servers, ctx) {
  const findings = [];
  const seen = new Map();
  for (const server of servers) {
    const id = serverIdentity(server);
    if (!id) continue;
    if (!seen.has(id)) {
      seen.set(id, server);
      continue;
    }
    const first = seen.get(id);
    const where = displayPath(first.configPath, ctx.cwd, ctx.home);
    findings.push(
      make(
        server,
        'duplicate-server',
        'medium',
        `Same command and arguments as "${first.name}" in ${where}.`
      )
    );
  }

  const byName = new Map();
  for (const server of servers) {
    const list = byName.get(server.name) || [];
    list.push(server);
    byName.set(server.name, list);
  }
  for (const list of byName.values()) {
    if (list.length < 2) continue;
    const firstId = serverIdentity(list[0]);
    for (const other of list.slice(1)) {
      const id = serverIdentity(other);
      if (id && firstId && id === firstId) continue;
      const where = displayPath(list[0].configPath, ctx.cwd, ctx.home);
      findings.push(
        make(
          other,
          'duplicate-name',
          'low',
          `The name "${other.name}" is also used in ${where} for a different command. Which definition runs depends on the client.`
        )
      );
    }
  }
  return findings;
}

function serverIdentity(server) {
  if (server.url && server.transport !== 'stdio') return `url:${normalizeUrl(server.url)}`;
  if (!server.command) return null;
  const args = (server.args || []).map((arg) => String(arg).trim()).join('\0');
  return `cmd:${basenameCommand(server.command)}\0${args}`;
}

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    const pathname = u.pathname.replace(/\/+$/, '');
    const auth = u.username ? `${u.username}@` : '';
    return `${u.protocol}//${auth}${u.host}${pathname}${u.search}`;
  } catch {
    return String(raw).trim().replace(/\/+$/, '');
  }
}

function make(server, rule, severity, message, location) {
  return {
    rule,
    severity,
    target: server.name,
    targetKind: 'server',
    configPath: server.configPath,
    message,
    location: location || null,
  };
}

module.exports = {
  checkServers,
  serverIdentity,
  shellScriptOf,
};
