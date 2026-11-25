'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { estimateTokens } = require('./tokens');

// Characters that hide or reorder text. A leading BOM is ignored.
const HIDDEN_RANGES = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x206f],
  [0xfeff, 0xfeff],
];

// Letters that look like ASCII and show up in homoglyph tricks.
const CONFUSABLE = new Set([
  0x0410, 0x0415, 0x041e, 0x0420, 0x0421, 0x0425, 0x0430, 0x0435, 0x043e, 0x0440, 0x0441, 0x0443,
  0x0445, 0x0455, 0x0456, 0x0458, 0x04bb, 0x039f, 0x03bf, 0x03b9,
]);

const OVERSIZE_MEDIUM = 24000;
const OVERSIZE_HIGH = 80000;

const REMOTE_EXEC = [
  /\bcurl\b[^|\n]{0,240}\|\s*(?:sudo\s+)?(?:ba)?sh\b/gi,
  /\bwget\b[^|\n]{0,240}\|\s*(?:sudo\s+)?(?:ba)?sh\b/gi,
  /\b(?:bash|sh|zsh)\b[^\n]{0,48}<\(\s*(?:curl|wget)\b/gi,
  /\beval\b[^\n]{0,60}\$\(\s*(?:curl|wget)\b/gi,
  /\b(?:iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n]{0,200}\|\s*iex\b/gi,
  /\b(?:curl|wget)\b[^\n]{0,200}\|\s*(?:sudo\s+)?(?:python3?|perl|ruby|node)\b/gi,
];

const SECRET_PATH =
  /(?:\.env\b|\.ssh\/(?:id_rsa|id_ed25519|id_ecdsa|config|authorized_keys)?|\.aws\/credentials|\.npmrc\b|\.netrc\b|\.pgpass\b|\.kube\/config|\.docker\/config\.json|credentials\.json)/gi;

const READ_VERB = /\b(?:read|open|cat|print|show|dump|collect|grab|load|copy|include|attach|paste|send|post|upload|exfiltrate)\b/i;
const SEND_VERB = /\b(?:send|post|upload|exfiltrate|transmit|forward|webhook|pastebin|leak)\b/i;
const URL_RE = /\bhttps?:\/\/[^\s)]+/i;

function checkSkillFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    const name = path.basename(path.dirname(filePath));
    return {
      skill: { name, path: filePath, bytes: 0, characters: 0 },
      findings: [
        skillFinding(
          filePath,
          name,
          'skill-unreadable',
          'medium',
          `Could not read skill: ${err.message}`,
          null
        ),
      ],
    };
  }
  return checkSkillText({ name: skillName(text, filePath), text, path: filePath });
}

function checkSkillText({ name, text, path: filePath }) {
  const findings = [];
  const remote = firstRemote(text);
  if (remote) {
    findings.push(
      skillFinding(
        filePath,
        name,
        'remote-exec',
        'high',
        `Instructions pipe a remote script into a shell or interpreter (line ${remote.line}).`,
        `line ${remote.line}`
      )
    );
  }
  findings.push(...credentialFindings(text, filePath, name));
  findings.push(...hiddenFindings(text, filePath, name));
  findings.push(...homoglyphFindings(text, filePath, name));
  findings.push(...sizeFindings(text, filePath, name));
  return {
    skill: {
      name,
      path: filePath,
      bytes: Buffer.byteLength(text),
      characters: text.length,
    },
    findings,
  };
}

function skillName(text, filePath) {
  const fm = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    const match = fm[1].match(/^name:\s*['"]?([^'"\n#]+?)['"]?\s*$/m);
    if (match && match[1].trim()) return match[1].trim();
  }
  if (path.basename(filePath) === 'SKILL.md') return path.basename(path.dirname(filePath));
  return path.basename(filePath);
}

function firstRemote(text) {
  let best = null;
  for (const re of REMOTE_EXEC) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text))) {
      if (negated(text, match.index)) continue;
      const line = lineAt(text, match.index);
      if (!best || line < best.line) best = { line };
      break;
    }
  }
  return best;
}

function credentialFindings(text, filePath, name) {
  SECRET_PATH.lastIndex = 0;
  let match;
  let best = null;
  while ((match = SECRET_PATH.exec(text))) {
    if (negated(text, match.index)) continue;
    const start = Math.max(0, match.index - 180);
    const end = Math.min(text.length, match.index + match[0].length + 180);
    const window = text.slice(start, end);
    const line = lineAt(text, match.index);
    const sends = SEND_VERB.test(window) || (READ_VERB.test(window) && URL_RE.test(window));
    if (sends) {
      best = { rule: 'credential-exfil', severity: 'high', line };
      break;
    }
    if (!best && READ_VERB.test(window)) {
      best = { rule: 'credential-read', severity: 'medium', line };
    }
  }
  if (!best) return [];
  const message =
    best.rule === 'credential-exfil'
      ? `Instructions read credential material and send it elsewhere (line ${best.line}).`
      : `Instructions tell the agent to read credential material (line ${best.line}).`;
  return [skillFinding(filePath, name, best.rule, best.severity, message, `line ${best.line}`)];
}

function hiddenFindings(text, filePath, name) {
  const found = [];
  let line = 1;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i);
    const width = cp > 0xffff ? 2 : 1;
    if (!(cp === 0xfeff && i === 0) && isHidden(cp)) found.push({ cp, line });
    if (cp === 0x0a) line += 1;
    i += width;
  }
  if (!found.length) return [];
  const labels = [];
  for (const item of found) {
    const label = formatCp(item.cp);
    if (!labels.includes(label)) labels.push(label);
  }
  const extra = found.length > 1 ? ` (${found.length} characters)` : '';
  return [
    skillFinding(
      filePath,
      name,
      'hidden-text',
      'high',
      `Hidden or direction-override characters at line ${found[0].line}: ${labels.slice(0, 6).join(', ')}${extra}.`,
      `line ${found[0].line}`
    ),
  ];
}

function homoglyphFindings(text, filePath, name) {
  const hits = [];
  const re = /[^\s]+/g;
  let match;
  while ((match = re.exec(text))) {
    const word = match[0];
    let latin = false;
    let conf = null;
    for (const ch of word) {
      const cp = ch.codePointAt(0);
      if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) latin = true;
      if (CONFUSABLE.has(cp)) conf = cp;
    }
    if (latin && conf != null) {
      hits.push({ word: word.slice(0, 40), cp: conf, line: lineAt(text, match.index) });
      if (hits.length >= 4) break;
    }
  }
  if (!hits.length) return [];
  const shown = hits.map((hit) => `"${hit.word}" (${formatCp(hit.cp)})`).join(', ');
  return [
    skillFinding(
      filePath,
      name,
      'homoglyph',
      'medium',
      `Mixed-script tokens use letters that look like ASCII: ${shown}.`,
      `line ${hits[0].line}`
    ),
  ];
}

function sizeFindings(text, filePath, name) {
  if (text.length < OVERSIZE_MEDIUM) return [];
  const severity = text.length >= OVERSIZE_HIGH ? 'high' : 'medium';
  const tokens = estimateTokens(text);
  return [
    skillFinding(
      filePath,
      name,
      'oversized-skill',
      severity,
      `SKILL.md is ${text.length} characters (about ${tokens} tokens at 4 characters per token). Large skills crowd the prompt.`,
      null
    ),
  ];
}

function isHidden(cp) {
  if (cp >= 0xe0001 && cp <= 0xe007f) return true;
  return HIDDEN_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

function formatCp(cp) {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

function negated(text, index) {
  const window = text.slice(Math.max(0, index - 100), index);
  return /\b(?:do not|don't|dont|never|avoid|must not|should not)\b/i.test(window);
}

function skillFinding(filePath, name, rule, severity, message, location) {
  return {
    rule,
    severity,
    target: name,
    targetKind: 'skill',
    configPath: filePath,
    message,
    location,
  };
}

module.exports = {
  checkSkillFile,
  checkSkillText,
  skillName,
  OVERSIZE_MEDIUM,
  OVERSIZE_HIGH,
};
