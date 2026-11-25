'use strict';

const path = require('node:path');

function basenameCommand(command) {
  const raw = String(command || '');
  let base = path.win32.basename(raw);
  base = path.posix.basename(base).toLowerCase();
  return base.replace(/\.exe$/, '').replace(/\.cmd$/, '');
}

function displayPath(filePath, cwd, home) {
  if (!filePath) return '';
  const abs = path.resolve(filePath);
  // Prefer the project path. On CI the checkout lives inside the runner home,
  // and a developer project usually does too.
  const cwdAbs = cwd ? path.resolve(cwd) : '';
  if (cwdAbs && (abs === cwdAbs || abs.startsWith(cwdAbs + path.sep))) {
    const rel = path.relative(cwdAbs, abs);
    if (rel) return rel.split(path.sep).join('/');
    return '.';
  }
  const homeAbs = home ? path.resolve(home) : '';
  if (homeAbs && (abs === homeAbs || abs.startsWith(homeAbs + path.sep))) {
    return '~' + abs.slice(homeAbs.length).split(path.sep).join('/');
  }
  return abs.split(path.sep).join('/');
}

function normalizeForCompare(p, platform) {
  if (!p) return '';
  let s = String(p);
  if (platform === 'win32') s = s.replace(/\//g, '\\');
  if (s.length > 1 && (s.endsWith('/') || s.endsWith('\\'))) s = s.slice(0, -1);
  s = path.normalize(s);
  return platform === 'win32' ? s.toLowerCase() : s;
}

function expandTilde(value, home) {
  if (!home) return value;
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(home, value.slice(2));
  return value;
}

const HOME_REF_LIST = [
  '~',
  '~/',
  '~\\',
  '${userHome}',
  '${env:HOME}',
  '${HOME}',
  '$HOME',
  '%USERPROFILE%',
  '%HOME%',
];

const HOME_REFS = new Set(HOME_REF_LIST);

function isSymbolicHome(value) {
  let v = String(value ?? '').trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return HOME_REFS.has(v);
}

// 'root' or 'home' when the value is the filesystem root or the home directory.
// Subdirectories are not flagged. A project folder is a normal scope.
function isBroadRoot(value, home, platform) {
  if (value == null) return null;
  let v = String(value).trim();
  if (!v) return null;
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  const plat = platform || process.platform;
  if (HOME_REFS.has(v)) return 'home';
  if (plat === 'win32') {
    if (/^[a-zA-Z]:[\\/]?$/.test(v) || v === '/' || v === '\\') return 'root';
  } else if (v === '/' || v === '//' || v === '\\') {
    return 'root';
  }
  if (home) {
    const homeNorm = normalizeForCompare(home, plat);
    const valueNorm = normalizeForCompare(expandTilde(v, home), plat);
    if (valueNorm && homeNorm && valueNorm === homeNorm) return 'home';
  }
  return null;
}

function splitVolumeHost(item) {
  const s = String(item);
  if (/^[A-Za-z]:[\\/]/.test(s)) {
    const idx = s.indexOf(':', 2);
    return idx === -1 ? s : s.slice(0, idx);
  }
  const idx = s.indexOf(':');
  return idx === -1 ? s : s.slice(0, idx);
}

function mountSources(item) {
  if (!item) return [];
  const sources = [];
  const re = /(?:^|,)source=([^,]+)/g;
  let m;
  while ((m = re.exec(String(item)))) sources.push(m[1]);
  return sources;
}

function dockerHostPaths(args) {
  const hosts = [];
  const list = args || [];
  for (let i = 0; i < list.length; i += 1) {
    let item = list[i];
    if (item === '-v' || item === '--volume') {
      item = list[(i += 1)];
    } else if (typeof item === 'string' && item.startsWith('--volume=')) {
      item = item.slice('--volume='.length);
    } else if (item === '--mount') {
      hosts.push(...mountSources(list[(i += 1)]));
      continue;
    } else if (typeof item === 'string' && item.startsWith('--mount=')) {
      hosts.push(...mountSources(item.slice('--mount='.length)));
      continue;
    } else {
      continue;
    }
    if (item) hosts.push(splitVolumeHost(item));
  }
  return hosts.filter(Boolean);
}

const DIR_KEY =
  /(?:^|_)(?:dir|dirs|directory|directories|root|folder|folders|path|paths|filesystem|fs|allow|allowed)(?:$|_)/i;

const DIR_SKIP = new Set([
  'PATH',
  'NODE_PATH',
  'PYTHONPATH',
  'CLASSPATH',
  'MANPATH',
  'INFOPATH',
  'PSMODULEPATH',
]);

function directoryEnvValues(env, platform) {
  const delim = platform === 'win32' ? ';' : ':';
  const values = [];
  for (const [key, value] of Object.entries(env || {})) {
    if (DIR_SKIP.has(String(key).toUpperCase())) continue;
    if (!DIR_KEY.test(key)) continue;
    const whole = String(value).trim();
    if (!whole) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(whole)) {
      values.push({ key, value: whole });
      continue;
    }
    const parts = whole.includes(delim) ? whole.split(delim) : [whole];
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed) values.push({ key, value: trimmed });
    }
  }
  return values;
}

module.exports = {
  basenameCommand,
  displayPath,
  isBroadRoot,
  isSymbolicHome,
  dockerHostPaths,
  directoryEnvValues,
};
