'use strict';

const { basenameCommand } = require('./paths');

const FLOATING = /^(?:latest|next|\*|canary)$/i;

function npmPin(spec) {
  const s = String(spec || '').trim();
  if (!s || s.startsWith('-')) return null;
  if (/^(?:\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(s)) return null;
  if (/\.(?:js|mjs|cjs|ts|py|sh)$/i.test(s) && !s.startsWith('@') && !s.includes('/')) {
    return null;
  }
  if (/^(?:https?:|git\+|github:|gitlab:|bitbucket:|file:)/i.test(s)) {
    return { spec: s, pinned: /#[0-9a-f]{7,40}$/i.test(s), manager: 'npx' };
  }
  let version = '';
  if (s.startsWith('@')) {
    const slash = s.indexOf('/');
    if (slash === -1) return { spec: s, pinned: false, manager: 'npx' };
    const at = s.indexOf('@', slash + 1);
    version = at === -1 ? '' : s.slice(at + 1);
  } else {
    const at = s.indexOf('@');
    version = at === -1 ? '' : s.slice(at + 1);
  }
  return { spec: s, pinned: version !== '' && !FLOATING.test(version), manager: 'npx' };
}

function extractNpxLike(args) {
  const pkgs = [];
  const valueFlags = new Set([
    '-p',
    '--package',
    '--npm',
    '--node-arg',
    '--node-options',
    '-n',
    '-c',
    '--call',
    '--registry',
    '--userconfig',
    '--cache',
    '--prefix',
  ]);
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--') {
      if (args[i + 1]) pkgs.push(args[i + 1]);
      break;
    }
    if (typeof a === 'string' && a.startsWith('--package=')) {
      pkgs.push(a.slice('--package='.length));
      continue;
    }
    if (valueFlags.has(a)) {
      const val = args[(i += 1)];
      if ((a === '-p' || a === '--package') && val) pkgs.push(val);
      if (a === '-c' || a === '--call') break;
      continue;
    }
    if (typeof a === 'string' && a.startsWith('-')) continue;
    pkgs.push(a);
    break;
  }
  return pkgs;
}

function uvPin(spec) {
  const s = String(spec || '').trim();
  if (!s || s.startsWith('-')) return null;
  if (/^(?:\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(s)) return null;
  if (/^(?:https?:|git\+)/i.test(s)) {
    const rev = s.split('@').pop();
    return { spec: s, pinned: /^[0-9a-f]{7,40}$/i.test(rev || ''), manager: 'uvx' };
  }
  if (s.includes('==')) {
    const ver = s.split('==').pop();
    return { spec: s, pinned: Boolean(ver) && !FLOATING.test(ver), manager: 'uvx' };
  }
  const at = s.lastIndexOf('@');
  if (at > 0) {
    const ver = s.slice(at + 1);
    const branch = /^(?:latest|next|\*|main|master|HEAD)$/i.test(ver);
    return { spec: s, pinned: ver !== '' && !branch, manager: 'uvx' };
  }
  return { spec: s, pinned: false, manager: 'uvx' };
}

function extractUvx(args) {
  const pkgs = [];
  const valueFlags = new Set([
    '--from',
    '--with',
    '--python',
    '-p',
    '--index',
    '--index-url',
    '--extra-index-url',
    '--find-links',
    '--directory',
    '--project',
    '--refresh-package',
    '--python-preference',
  ]);
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--') {
      if (args[i + 1]) pkgs.push(args[i + 1]);
      break;
    }
    if (typeof a === 'string' && (a.startsWith('--from=') || a.startsWith('--with='))) {
      pkgs.push(a.slice(a.indexOf('=') + 1));
      continue;
    }
    if (valueFlags.has(a)) {
      const val = args[(i += 1)];
      if (val && (a === '--from' || a === '--with')) pkgs.push(val);
      continue;
    }
    if (typeof a === 'string' && a.startsWith('-')) continue;
    pkgs.push(a);
    break;
  }
  return pkgs;
}

function denoPin(spec) {
  const body = String(spec).replace(/^(?:npm|jsr):/, '');
  const pin = npmPin(body);
  if (!pin) return { spec: String(spec), pinned: false, manager: 'deno' };
  return { spec: String(spec), pinned: pin.pinned, manager: 'deno' };
}

function extractDeno(args) {
  const pkgs = [];
  for (const a of args) {
    if (/^(?:npm|jsr):/.test(a)) pkgs.push(a);
  }
  return pkgs;
}

function packagesOf(command, args) {
  const base = basenameCommand(command);
  const list = args || [];
  if (base === 'npx' || base === 'bunx') return extractNpxLike(list).map(npmPin).filter(Boolean);
  if (base === 'uvx') return extractUvx(list).map(uvPin).filter(Boolean);
  if (base === 'pnpm' || base === 'yarn') {
    const idx = list.findIndex((a) => a === 'dlx');
    if (idx === -1) return [];
    return extractNpxLike(list.slice(idx + 1))
      .map(npmPin)
      .filter(Boolean);
  }
  if (base === 'deno') return extractDeno(list).map(denoPin).filter(Boolean);
  return [];
}

module.exports = {
  npmPin,
  uvPin,
  packagesOf,
};
