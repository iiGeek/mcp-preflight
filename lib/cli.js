'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { formatJson, formatReport } = require('./report');
const { audit } = require('./run');
const { version } = require('./version');

const SEVERITIES = new Set(['info', 'low', 'medium', 'high']);

const HELP = `Audit MCP server configuration and agent skills.

Usage:
  mcp-preflight [options]

Options:
  --config <path>    Config file to read. Repeatable. JSON, JSONC, or TOML.
  --skills <dir>     SKILL.md file or a directory to scan. Repeatable.
  --cwd <dir>        Project root for discovery. Default: the current directory.
  --home <dir>       Home directory for discovery. Default: the user home.
  --only             Do not scan default locations. Requires --config or --skills.
  --live             Start local stdio servers and call tools/list.
  --timeout <ms>     Per-server limit for --live. Default: 8000.
  --json             Print a JSON report on stdout.
  --severity <level> Lowest severity to print: info, low, medium, or high.
  --no-color         Disable ANSI color.
  -h, --help         Show this help.
  --version          Show the version.

--config and --skills are relative to the current directory. --cwd and --home
only change where default configs and skills are discovered.

Discovery reads Claude Desktop, Claude Code (.mcp.json and ~/.claude.json),
Cursor, VS Code, Windsurf, and Codex, in the project and under home.
Skills are SKILL.md files under .claude/skills, .cursor/skills, .agents/skills,
.codex/skills, and .windsurf/skills, plus the same directories in home.

--live executes each enabled stdio command. It does not contact remote servers.
Read the static findings before using it on a config you do not trust.

Exit codes:
  0  No high-severity findings.
  1  One or more high-severity findings.
  2  The command could not be run.

--severity filters the report. It does not change the exit code.
`;

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (opts.version) {
    process.stdout.write(`${version}\n`);
    return 0;
  }
  try {
    validate(opts);
  } catch (err) {
    console.error(err.message);
    return 2;
  }

  const result = await audit({
    cwd: opts.cwd,
    home: opts.home,
    configs: opts.configs,
    skills: opts.skills,
    only: opts.only,
    live: opts.live,
    timeoutMs: opts.timeout,
  });

  if (opts.json) process.stdout.write(formatJson(result, opts.severity));
  else {
    process.stdout.write(
      formatReport(result, {
        severity: opts.severity,
        color: opts.color,
      })
    );
  }
  return result.summary.high > 0 ? 1 : 0;
}

function parseArgs(argv) {
  const opts = {
    configs: [],
    skills: [],
    cwd: process.cwd(),
    home: null,
    only: false,
    live: false,
    timeout: 8000,
    json: false,
    severity: 'info',
    noColor: false,
    help: false,
    version: false,
    color: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`);
      }
      i += 1;
      return value;
    };
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--version') opts.version = true;
    else if (arg === '--only') opts.only = true;
    else if (arg === '--live') opts.live = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--no-color') opts.noColor = true;
    else if (arg === '--config') opts.configs.push(take());
    else if (arg.startsWith('--config=')) opts.configs.push(arg.slice('--config='.length));
    else if (arg === '--skills') opts.skills.push(take());
    else if (arg.startsWith('--skills=')) opts.skills.push(arg.slice('--skills='.length));
    else if (arg === '--cwd') opts.cwd = take();
    else if (arg.startsWith('--cwd=')) opts.cwd = arg.slice('--cwd='.length);
    else if (arg === '--home') opts.home = take();
    else if (arg.startsWith('--home=')) opts.home = arg.slice('--home='.length);
    else if (arg === '--timeout') opts.timeout = parseTimeout(take());
    else if (arg.startsWith('--timeout=')) opts.timeout = parseTimeout(arg.slice('--timeout='.length));
    else if (arg === '--severity') opts.severity = parseSeverity(take());
    else if (arg.startsWith('--severity=')) opts.severity = parseSeverity(arg.slice('--severity='.length));
    else throw new Error(`Unknown argument: ${arg}`);
  }

  opts.color = !opts.noColor && !opts.json && Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  if (!opts.home) opts.home = require('node:os').homedir();
  return opts;
}

function parseTimeout(value) {
  if (!/^\d+$/.test(value)) throw new Error('--timeout expects a whole number of milliseconds');
  const n = Number(value);
  if (n < 1) throw new Error('--timeout must be at least 1');
  return n;
}

function parseSeverity(value) {
  if (!SEVERITIES.has(value)) {
    throw new Error('--severity must be info, low, medium, or high');
  }
  return value;
}

function validate(opts) {
  assertDir(opts.cwd, '--cwd');
  assertDir(opts.home, '--home');
  if (opts.only && opts.configs.length === 0 && opts.skills.length === 0) {
    throw new Error('--only needs at least one --config or --skills path');
  }
  for (const file of opts.configs) {
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) throw new Error(`Config not found: ${file}`);
  }
  for (const file of opts.skills) {
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) throw new Error(`Skills path not found: ${file}`);
  }
}

function assertDir(dir, flag) {
  let st;
  try {
    st = fs.statSync(dir);
  } catch {
    throw new Error(`${flag} is not a directory: ${dir}`);
  }
  if (!st.isDirectory()) throw new Error(`${flag} is not a directory: ${dir}`);
}

module.exports = {
  main,
  parseArgs,
  HELP,
};
