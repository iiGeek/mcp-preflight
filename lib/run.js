'use strict';

const os = require('node:os');
const path = require('node:path');

const { checkServers, serverIdentity } = require('./checks');
const { collectExplicitSkills, discover } = require('./discover');
const { guessClient, loadConfigFile } = require('./load-config');
const { probeServer } = require('./live');
const { checkSkillFile } = require('./skills');
const { analyzeTools, toolFindings } = require('./tools');
const { redactText } = require('./text');
const { version } = require('./version');

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2, info: 3 };

async function audit(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const home = path.resolve(options.home || os.homedir());
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const discovered = options.only ? { configs: [], skills: [] } : discover({ cwd, home, platform, env });

  const configEntries = discovered.configs.map((entry) => ({ ...entry }));
  const seenConfigs = new Set(configEntries.map((entry) => entry.path));
  for (const raw of options.configs || []) {
    const abs = path.resolve(raw);
    if (seenConfigs.has(abs)) continue;
    seenConfigs.add(abs);
    configEntries.push({
      client: guessClient(abs),
      scope: 'explicit',
      path: abs,
      explicit: true,
    });
  }

  const configs = [];
  const servers = [];
  const findings = [];
  for (const entry of configEntries) {
    const loaded = loadConfigFile(entry.path, entry);
    if (!loaded.include) continue;
    configs.push({
      client: entry.client,
      path: entry.path,
      scope: entry.scope,
      error: loaded.error,
    });
    servers.push(...loaded.servers);
    findings.push(...loaded.findings);
  }

  findings.push(...checkServers(servers, { cwd, home, platform }));

  const skillPaths = [...discovered.skills];
  const seenSkills = new Set(skillPaths);
  for (const raw of options.skills || []) {
    collectExplicitSkills(path.resolve(raw), skillPaths, seenSkills);
  }
  skillPaths.sort();

  const skills = [];
  for (const filePath of skillPaths) {
    const checked = checkSkillFile(filePath);
    skills.push(checked.skill);
    findings.push(...checked.findings);
  }

  if (options.live) {
    await probeAll(servers, findings, {
      cwd,
      home,
      timeoutMs: options.timeoutMs || 8000,
      version,
    });
  }

  findings.sort(compareFindings);
  return {
    version,
    cwd,
    home,
    configs,
    servers,
    skills,
    findings,
    summary: summarize(findings, configs, servers, skills),
  };
}

async function probeAll(servers, findings, options) {
  const cache = new Map();
  for (const server of servers) {
    if (server.disabled || server.transport !== 'stdio' || !server.command) {
      server.live = {
        status: 'skipped',
        reason: server.disabled ? 'disabled' : server.transport !== 'stdio' ? 'not a stdio server' : 'no command',
      };
      continue;
    }
    const id = serverIdentity(server) || `${server.configPath}\0${server.name}`;
    if (!cache.has(id)) {
      const probed = await probeServer(server, options);
      if (!probed.ok) {
        const reason = redactText(probed.reason || 'Live probe failed.');
        cache.set(id, {
          live: { status: 'failed', reason },
          extra: [
            {
              rule: 'live-failed',
              severity: 'medium',
              target: server.name,
              targetKind: 'server',
              configPath: server.configPath,
              message: reason,
              location: 'tools/list',
            },
          ],
          used: false,
        });
      } else {
        const analysis = analyzeTools(probed.tools);
        cache.set(id, {
          live: {
            status: 'ok',
            toolCount: analysis.toolCount,
            estimatedTokens: analysis.estimatedTokens,
            tools: analysis.tools,
            truncated: analysis.truncated || undefined,
          },
          extra: toolFindings(server, analysis),
          used: false,
        });
      }
    }
    const hit = cache.get(id);
    server.live = hit.live;
    if (!hit.used) {
      findings.push(...hit.extra);
      hit.used = true;
    }
  }
}

function compareFindings(a, b) {
  const bySeverity = (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);
  if (bySeverity) return bySeverity;
  if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
  if (a.target !== b.target) return a.target < b.target ? -1 : 1;
  const byPath = String(a.configPath).localeCompare(String(b.configPath));
  if (byPath) return byPath;
  return String(a.location || '').localeCompare(String(b.location || ''));
}

function summarize(findings, configs, servers, skills) {
  const summary = {
    configs: configs.length,
    servers: servers.length,
    skills: skills.length,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
    ok: true,
  };
  for (const finding of findings) {
    if (Object.prototype.hasOwnProperty.call(summary, finding.severity)) {
      summary[finding.severity] += 1;
    }
  }
  summary.ok = summary.high === 0;
  return summary;
}

module.exports = {
  audit,
};
