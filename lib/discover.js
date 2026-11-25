'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_FILES = [
  { client: 'claude-code', scope: 'project', rel: '.mcp.json' },
  { client: 'cursor', scope: 'project', rel: path.join('.cursor', 'mcp.json') },
  { client: 'vscode', scope: 'project', rel: path.join('.vscode', 'mcp.json') },
  { client: 'windsurf', scope: 'project', rel: path.join('.windsurf', 'mcp_config.json') },
  { client: 'codex', scope: 'project', rel: path.join('.codex', 'config.toml') },
];

const SKILL_DIRS = [
  path.join('.claude', 'skills'),
  path.join('.cursor', 'skills'),
  path.join('.agents', 'skills'),
  path.join('.codex', 'skills'),
  path.join('.windsurf', 'skills'),
];

const SKIP_DIRS = new Set(['node_modules', '.git', '.trash']);

function discover(options) {
  const configs = [];
  const seen = new Set();
  const add = (entry) => {
    const abs = path.resolve(entry.path);
    if (seen.has(abs)) return;
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      return;
    }
    if (!st.isFile()) return;
    seen.add(abs);
    configs.push({ client: entry.client, scope: entry.scope, path: abs });
  };

  for (const item of PROJECT_FILES) {
    add({ client: item.client, scope: item.scope, path: path.join(options.cwd, item.rel) });
  }
  for (const item of userConfigCandidates(options)) add(item);

  const skills = [];
  const skillSeen = new Set();
  for (const rel of SKILL_DIRS) {
    collectSkills(path.join(options.cwd, rel), skills, skillSeen);
    collectSkills(path.join(options.home, rel), skills, skillSeen);
  }
  skills.sort();
  return { configs, skills };
}

function userConfigCandidates(options) {
  const home = options.home;
  const platform = options.platform || process.platform;
  const env = options.env || {};
  return [
    { client: 'claude-desktop', scope: 'user', path: claudeDesktopConfig(home, platform, env) },
    { client: 'claude-code', scope: 'user', path: path.join(home, '.claude.json') },
    { client: 'cursor', scope: 'user', path: path.join(home, '.cursor', 'mcp.json') },
    { client: 'vscode', scope: 'user', path: vscodeUserConfig(home, platform, env) },
    { client: 'windsurf', scope: 'user', path: path.join(home, '.codeium', 'windsurf', 'mcp_config.json') },
    { client: 'codex', scope: 'user', path: path.join(home, '.codex', 'config.toml') },
  ];
}

function claudeDesktopConfig(home, platform, env) {
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  if (platform === 'win32') {
    const base = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(base, 'Claude', 'claude_desktop_config.json');
  }
  return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
}

function vscodeUserConfig(home, platform, env) {
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
  }
  if (platform === 'win32') {
    const base = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(base, 'Code', 'User', 'mcp.json');
  }
  return path.join(home, '.config', 'Code', 'User', 'mcp.json');
}

function collectSkills(root, out, seen) {
  walkSkills(root, out, seen, 0, false);
}

// Explicit --skills paths may be a SKILL.md file or a directory, and the
// directory itself may be a symlink the user asked us to read.
function collectExplicitSkills(root, out, seen) {
  let st;
  try {
    st = fs.statSync(root);
  } catch {
    return;
  }
  if (st.isFile()) {
    if (path.basename(root) === 'SKILL.md') addSkill(root, out, seen);
    return;
  }
  if (st.isDirectory()) walkSkills(root, out, seen, 0, true);
}

function walkSkills(dir, out, seen, depth, followedRoot) {
  if (depth > 4) return;
  let listed;
  try {
    const st = followedRoot && depth === 0 ? fs.statSync(dir) : fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return;
    listed = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  addSkill(path.join(dir, 'SKILL.md'), out, seen);
  for (const ent of listed) {
    if (SKIP_DIRS.has(ent.name) || !ent.isDirectory()) continue;
    walkSkills(path.join(dir, ent.name), out, seen, depth + 1, false);
  }
}

function addSkill(filePath, out, seen) {
  let st;
  try {
    st = fs.statSync(filePath);
  } catch {
    return;
  }
  if (!st.isFile()) return;
  const abs = path.resolve(filePath);
  if (seen.has(abs)) return;
  seen.add(abs);
  out.push(abs);
}

module.exports = {
  discover,
  collectExplicitSkills,
  userConfigCandidates,
  SKILL_DIRS,
};
