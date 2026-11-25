# mcp-preflight

`mcp-preflight` audits MCP server configuration and agent skills on the local machine. It looks for inline secrets, broad filesystem access, unpinned packages, cleartext remote URLs, shell interpolation, duplicate servers, and skill instructions that are unsafe or hard to see. A run finishes in seconds. It does not contact the network unless you pass `--live`.

The program is plain Node.js 18 or newer and has no runtime dependencies.

## Install

```bash
npm install -g mcp-preflight
mcp-preflight --help
```

Without a global install:

```bash
npx mcp-preflight
```

## Usage

Run it in a project directory. It discovers configs and `SKILL.md` files in that project and under your home directory.

```bash
mcp-preflight
mcp-preflight --json
mcp-preflight --config .mcp.json --only
mcp-preflight --skills .claude/skills --only
mcp-preflight --live --timeout 8000
```

`--config` and `--skills` are relative to the current directory and can be repeated. `--cwd` and `--home` change the project root and home directory used for discovery. `--only` skips discovery and reads only the paths you passed.

`--live` starts each enabled stdio server, performs the MCP handshake (`initialize`, then `notifications/initialized`), and calls `tools/list`, following `nextCursor` for up to 50 pages. Remote HTTP servers are not contacted. The child receives `PATH` and a short list of locale and temp variables, plus the env block from the config. `${VAR}` and `${env:VAR}` in that block are filled from the parent process. Review the static findings before using `--live` on a config you do not trust. Probes run one at a time. On timeout the process group is terminated.

## What it checks

### Servers

| Rule | Severity | Meaning |
| --- | --- | --- |
| `inline-secret` | high | A sensitive env value, header, argument, URL password, or known token shape is written into the config. Prefer a reference such as `${API_KEY}`, `${env:API_KEY}`, or `${input:api-key}`. |
| `broad-filesystem` | high | An argument, working directory, directory env value, or Docker mount is the filesystem root or the home directory. |
| `cleartext-remote` | high | A remote `http://` or `ws://` URL. Loopback is reported separately as `loopback-http` (low). |
| `shell-interpolation` | high | The command is a shell (`bash -c`, `powershell -Command`, `cmd /c`, and similar) and the script uses command substitution or variable expansion. A `$VAR` inside single quotes is not flagged. |
| `unpinned-package` | medium | `npx`, `bunx`, `pnpm dlx`, `yarn dlx`, `uvx`, or `deno` launches a package with no version, or with `@latest`, `@next`, or `*`. A range such as `^1.2.3` counts as pinned. `uvx` treats `name==version` as pinned. |
| `duplicate-server` | medium | Two entries launch the same command and arguments, or share the same URL. Env values are ignored. |
| `duplicate-name` | low | The same server name is defined twice with different commands. |
| `config-invalid` | medium | A config or server entry could not be parsed, or it has neither a command nor a URL. |
| `config-ambiguous` | low | Both `command` and `url` are set. Clients disagree on which one wins. |
| `missing-type` | low | A URL server has no `type`. Claude Code skips those entries. |
| `missing-annotation` | medium | With `--live`, a tool omits `readOnlyHint`, or omits `destructiveHint` while it is not read-only. The spec defaults those to false and true, so a client treats the tool as a destructive write. |
| `destructive-tool` | medium | With `--live`, the name or description suggests a destructive action and `readOnlyHint` is not true. |
| `annotation-mismatch` | medium | With `--live`, `readOnlyHint` is true but the name suggests a destructive action. Annotations are hints, not a guarantee. |
| `live-failed` | medium | The stdio probe did not return `tools/list` before the timeout. |

### Skills

| Rule | Severity | Meaning |
| --- | --- | --- |
| `remote-exec` | high | Instructions fetch a script and pipe it into a shell or interpreter (`curl` or `wget` into `sh` or `bash`, `bash <(curl ...)`, `eval "$(curl ...)"`, or `iwr` into `iex`). A "do not" or "never" in the preceding words suppresses the match. |
| `credential-exfil` | high | Instructions read credential material (dotenv files, SSH private keys, cloud credential files) and send it somewhere. |
| `credential-read` | medium | Instructions tell the agent to read those files, without an obvious send. |
| `hidden-text` | high | Zero-width characters, bidi overrides, or Unicode tags. A leading byte-order mark is ignored. |
| `homoglyph` | medium | A token mixes ASCII letters with confusable Cyrillic or Greek letters. |
| `oversized-skill` | medium, or high past 80,000 characters | `SKILL.md` is at least 24,000 characters. The token figure is the JavaScript string length divided by 4. |

### Live tool cost

`--live` prints the tool count and an estimated token cost. Each tool costs `Math.ceil(JSON.stringify(tool).length / 4)`, and the server total is the sum. This is a rough stand-in for prompt size, not a model tokenizer. At most 500 tools are counted.

## Where it looks

Project directory:

- `.mcp.json` (Claude Code)
- `.cursor/mcp.json` (Cursor)
- `.vscode/mcp.json` (VS Code, usually under `servers`)
- `.windsurf/mcp_config.json` (Windsurf)
- `.codex/config.toml` (Codex, `[mcp_servers.<name>]`)

Home directory:

- Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `~/.config/Claude/claude_desktop_config.json` on Linux, `%APPDATA%\Claude\claude_desktop_config.json` on Windows
- Claude Code: `~/.claude.json`, both the user-level `mcpServers` object and `projects.<path>.mcpServers`
- Cursor: `~/.cursor/mcp.json`
- VS Code: `~/Library/Application Support/Code/User/mcp.json` on macOS, `~/.config/Code/User/mcp.json` on Linux, `%APPDATA%\Code\User\mcp.json` on Windows
- Windsurf: `~/.codeium/windsurf/mcp_config.json`
- Codex: `~/.codex/config.toml`

JSON files may contain comments and trailing commas. The TOML reader understands the Codex `mcp_servers` subset and ignores other tables in `config.toml`.

Skills are `SKILL.md` files under `.claude/skills`, `.cursor/skills`, `.agents/skills`, `.codex/skills`, and `.windsurf/skills`, in the project and in home. Symlinked skill directories are not followed.

Disabled servers (`disabled: true` or `enabled: false`) are still checked statically and are not started by `--live`.

## Example

`fixtures/example` is a small project with a few configs and two skills. Cursor's sample config is stored as `fixtures/example/cursor-mcp.json` so this repository does not contain a `.cursor` directory. The command below copies the example and puts that file where Cursor would read it:

```bash
tmp=$(mktemp -d)
mkdir -p "$tmp/project/.cursor"
cp -a fixtures/example/.claude fixtures/example/.codex fixtures/example/.mcp.json "$tmp/project/"
cp -a fixtures/example/home "$tmp/home"
cp fixtures/example/cursor-mcp.json "$tmp/project/.cursor/mcp.json"
node bin/mcp-preflight.js --cwd "$tmp/project" --home "$tmp/home" --no-color
```

```text
mcp-preflight 0.1.0

Configs
  claude-code      .mcp.json
  cursor           .cursor/mcp.json
  codex            .codex/config.toml
  claude-code      ~/.claude.json

Servers
  notes            stdio  npx -y @example/notes-mcp@1.4.2
                   .mcp.json
  files            stdio  npx -y @modelcontextprotocol/server-filesystem@2025.1.0 /
                   .mcp.json
  search           stdio  npx -y mcp-server-search
                   .mcp.json
  intranet         http   http://intranet.example.com/mcp
                   .mcp.json
  local-preview    http   http://127.0.0.1:3000/mcp
                   .mcp.json
  files            stdio  npx -y @modelcontextprotocol/server-filesystem@2025.1.0 /
                   .cursor/mcp.json
  wrap             stdio  bash -lc "echo connected as $USER"
                   .cursor/mcp.json
  fetch            stdio  npx -y @example/fetch-mcp@2.0.0
                   .codex/config.toml
  docs             stdio  uvx mcp-server-docs==0.3.1
                   ~/.claude.json
  local-git        stdio  uvx mcp-server-git
                   ~/.claude.json  project /work/demo

Skills
  notes            .claude/skills/notes/SKILL.md
  risky-setup      .claude/skills/risky-setup/SKILL.md

Findings
high   broad-filesystem       files
  Grants access to the filesystem root via args[2]. Point the server at a specific project directory instead.
  .cursor/mcp.json  args[2]

high   broad-filesystem       files
  Grants access to the filesystem root via args[2]. Point the server at a specific project directory instead.
  .mcp.json  args[2]

high   cleartext-remote       intranet
  Remote URL http://intranet.example.com/mcp uses cleartext http. Traffic to that host is not encrypted.
  .mcp.json  url

high   credential-exfil       risky-setup
  Instructions read credential material and send it elsewhere (line 12).
  .claude/skills/risky-setup/SKILL.md  line 12

high   inline-secret          files
  Env API_KEY is a literal value. Reference it from the environment instead, for example ${API_KEY}.
  .mcp.json  env.API_KEY

high   remote-exec            risky-setup
  Instructions pipe a remote script into a shell or interpreter (line 10).
  .claude/skills/risky-setup/SKILL.md  line 10

high   shell-interpolation    wrap
  bash evaluates a shell string with variable expansion. Clients normally exec the command directly; a shell evaluates the string.
  .cursor/mcp.json  args

medium duplicate-server       files
  Same command and arguments as "files" in .mcp.json.
  .cursor/mcp.json

medium unpinned-package       local-git
  uvx will launch "mcp-server-git" without a version pin. A bare name or a latest tag can change on the next run.
  ~/.claude.json  args

medium unpinned-package       search
  npx will launch "mcp-server-search" without a version pin. A bare name or a latest tag can change on the next run.
  .mcp.json  args

low    loopback-http          local-preview
  Loopback URL http://127.0.0.1:3000/mcp uses cleartext http.
  .mcp.json  url

Summary
  4 configs, 10 servers, 2 skills
  7 high, 3 medium, 1 low
```

The process exits 1 because of the high findings. The literal API key in that fixture is not printed.

A `--live` run against the local fixture server:

```bash
node bin/mcp-preflight.js --only --config fixtures/live/mcp.json --live --no-color
```

```text
mcp-preflight 0.1.0

Configs
  file             fixtures/live/mcp.json

Servers
  demo             stdio  node fixtures/fake-server.js
                   fixtures/live/mcp.json
                   live: 2 tools, about 101 tokens

Skills
  none

Findings
medium destructive-tool       demo
  Tools whose name or description suggests a destructive action, without readOnlyHint true: delete_note (name).
  fixtures/live/mcp.json  tools/list

medium missing-annotation     demo
  Tools missing annotations: delete_note (readOnlyHint, destructiveHint). A missing readOnlyHint defaults to false and a missing destructiveHint defaults to true, so clients treat the tool as a destructive write. Annotations are hints, not enforcement.
  fixtures/live/mcp.json  tools/list

Summary
  1 config, 1 server, 0 skills
  0 high, 2 medium, 0 low
```

That run exits 0. Medium findings do not fail the process. `get_note` sets both hints, so only `delete_note` is reported.

## JSON and exit codes

`--json` writes the report to stdout and nothing else. Env values are omitted. Token-shaped strings in arguments and URLs are replaced with `<redacted>`.

| Code | Meaning |
| --- | --- |
| 0 | No high-severity findings. |
| 1 | One or more high-severity findings. |
| 2 | The command could not be run (missing file, bad flag). |

`--severity` filters the printed findings. It does not change the exit code. In the JSON report, `summary` always counts every severity, and `summary.ok` is true when there are no high findings.

## Limitations

The checks are heuristics. A report with no findings does not mean a server or skill is safe, and a finding can be wrong.

- Inline secrets are detected from sensitive names and a handful of token shapes. A short password, or a secret stored under an ordinary name, is missed. A realistic placeholder can be flagged.
- Filesystem scope is only the root directory and the home directory. A wide but narrower path, such as `/Users`, is not flagged.
- Any package version other than a missing version, `@latest`, `@next`, or `*` counts as pinned, including ranges. `npx -y` and `npx --yes` are not treated as the same command when looking for duplicates.
- Shell detection is by command name (`bash`, `sh`, `zsh`, `fish`, `pwsh`, `cmd`, and a few others).
- `--live` speaks stdio only. It does not call tools, and it does not open remote HTTP servers. On Windows, a launcher such as `npx` may leave a grandchild process if the process group cannot be signaled.
- Tool annotations are reported as the server sent them. The MCP specification says clients must not trust annotations from untrusted servers.
- Skill checks are text searches. They do not run the skill. A negation such as "do not" just before a match is skipped, so a real instruction worded that way can be missed.
- The TOML reader does not implement all of TOML. It targets Codex `mcp_servers` tables.

## Development

```bash
npm test
```

Tests use the Node.js built-in test runner. GitHub Actions runs them on Node 18, 20, and 22.
