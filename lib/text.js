'use strict';

// Key names that usually carry a credential when the value is a literal.
const SENSITIVE_KEY =
  /(?:^|[^a-z0-9])(?:api[-_]?key|secret|passwd|password|credential|private[-_]?key|access[-_]?key|client[-_]?secret|authorization|auth|token)(?:[^a-z0-9]|$)/i;

const TOKEN_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /AKIA[0-9A-Z]{16}/,
  /glpat-[A-Za-z0-9_-]{8,}/,
  /npm_[A-Za-z0-9]{20,}/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
];

const SENSITIVE_FLAG =
  /^(?:--?)(?:api[-_]?key|token|password|secret|auth|access[-_]?token|authorization)$/i;

function looksSensitiveKey(key) {
  return SENSITIVE_KEY.test(String(key));
}

function hasTokenShape(value) {
  const s = String(value);
  return TOKEN_PATTERNS.some((re) => re.test(s));
}

// What remains after ${VAR}, ${env:VAR}, $VAR, and %VAR% references are removed.
function remainder(value) {
  return String(value)
    .replace(/\$\{[^{}]+\}/g, '')
    .replace(/(^|[^\\])\$[A-Za-z_][A-Za-z0-9_]*/g, '$1')
    .replace(/%[A-Za-z_][A-Za-z0-9_]*%/g, '')
    .trim();
}

function isPlaceholder(value) {
  const v = String(value).trim();
  if (v.length < 8) return true;
  if (
    /^(?:x+|changeme|placeholder|todo|example|redacted|dummy|fake|password|secret|token|apikey|api-key|none|null|undefined|test|sample)$/i.test(
      v
    )
  ) {
    return true;
  }
  if (/^<[^>\n]+>$/.test(v)) return true;
  if (/^[xX*•.\-]+$/.test(v)) return true;
  if (
    /(?:example|placeholder|your[-_ ]?(?:api[-_ ]?)?key|xxx+|insert[-_ ]|replace[-_ ]me)/i.test(
      v
    ) &&
    v.length < 80
  ) {
    return true;
  }
  return false;
}

function looksLikePath(value) {
  return /^(?:~|\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(String(value));
}

function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function urlHasEmbeddedPassword(url) {
  const s = String(url).trim();
  const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]+)@/i);
  if (!m) return false;
  const info = m[1];
  const idx = info.indexOf(':');
  if (idx === -1) return false;
  const pass = decodeURIComponentSafe(info.slice(idx + 1));
  if (!pass) return false;
  if (!remainder(pass)) return false;
  if (isPlaceholder(pass) && !hasTokenShape(pass)) return false;
  return true;
}

// True when a sensitive key holds a real-looking literal, or any value matches
// a known token shape. References such as ${API_KEY} are not literals.
function sensitiveLiteral(key, value) {
  if (value == null) return false;
  const v = String(value).trim();
  if (!v) return false;
  if (hasTokenShape(v)) return true;
  if (!looksSensitiveKey(key)) return false;
  const rest = remainder(v);
  if (!rest) return false;
  if (isPlaceholder(rest)) return false;
  if (looksLikePath(rest)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rest) && !urlHasEmbeddedPassword(rest)) return false;
  if (/^(?:true|false|yes|no|on|off)$/i.test(rest)) return false;
  return rest.length >= 8;
}

function redactText(value) {
  if (value == null) return value;
  let s = String(value);
  s = s.replace(
    /([a-z][a-z0-9+.-]*:\/\/)([^/?#\s@]+):([^/?#\s@]+)@/gi,
    (_, scheme, user) => `${scheme}${user}:<redacted>@`
  );
  s = s.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '<redacted>');
  s = s.replace(/\bghp_[A-Za-z0-9]{20,}\b/g, '<redacted>');
  s = s.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '<redacted>');
  s = s.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '<redacted>');
  s = s.replace(
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
    '<redacted>'
  );
  s = s.replace(/\bAKIA[0-9A-Z]{16}\b/g, '<redacted>');
  s = s.replace(/\bglpat-[A-Za-z0-9_-]{8,}\b/g, '<redacted>');
  s = s.replace(/\bnpm_[A-Za-z0-9]{20,}\b/g, '<redacted>');
  s = s.replace(/\b(Bearer\s+)(?!\$|%)[A-Za-z0-9._~+/-]{12,}/g, '$1<redacted>');
  return s;
}

module.exports = {
  looksSensitiveKey,
  hasTokenShape,
  remainder,
  isPlaceholder,
  looksLikePath,
  urlHasEmbeddedPassword,
  sensitiveLiteral,
  redactText,
  SENSITIVE_FLAG,
};
