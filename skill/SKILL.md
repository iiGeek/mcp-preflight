---
name: mcp-preflight
description: Audit local MCP server configs and SKILL.md files for inline secrets, broad filesystem roots, unpinned launchers, cleartext remote URLs, shell interpolation, and risky skill instructions. Use when adding or reviewing MCP servers, mcp.json, .mcp.json, config.toml, or agent skills.
---

# mcp-preflight

Audit MCP servers and skills before trusting them. The command only reads config files unless `--live` is passed. `--live` starts the configured stdio commands.

## Run

From the project to audit:

```bash
npx mcp-preflight
npx mcp-preflight --json
npx mcp-preflight --config .mcp.json --only
npx mcp-preflight --skills .claude/skills --only
```

Use `--live` only after you have read the static findings. It executes each enabled stdio server, completes the MCP handshake, and calls `tools/list`.

```bash
npx mcp-preflight --live --timeout 8000
```

`--config` and `--skills` are relative to the shell's current directory. `--cwd` and `--home` change discovery only. Pass `--only` when you want to ignore the machine's other configs, which matters in CI and in this repository.

## Exit code

- 0: no high findings. Medium and low findings may still be present.
- 1: at least one high finding. This is the CI failure.
- 2: the command failed before it could audit (missing path, bad flag).

`--severity` filters the printed findings. It does not change the exit code. In JSON, `summary.ok` is true when there are no high findings. `summary` counts every severity even when the list is filtered.

## How to read a finding

Each finding has a severity, a rule id, a target (server or skill name), a config path, and a location such as `env.API_KEY` or `line 12`. The human report and the JSON `findings` array use the same rule ids. Do not print secret values while fixing a finding. The report names the key and redacts token-shaped text; it does not include env values.

Server rules:

- `inline-secret` (high): a literal credential is in env, headers, args, or a URL. Replace it with a reference such as `${API_KEY}`, `${env:API_KEY}`, or `${input:api-key}`. For Codex HTTP servers, set `bearer_token_env_var` to the variable name.
- `broad-filesystem` (high): an argument, working directory, directory env value, or Docker mount is the filesystem root or the home directory. Point it at the project directory.
- `cleartext-remote` (high): a remote `http://` or `ws://` URL. Use `https` or `wss`. `loopback-http` (low) is the same scheme on localhost and does not fail CI.
- `shell-interpolation` (high): the server is started through a shell string that expands variables or command substitution. Pass `command` and `args` so the client execs the program directly.
- `unpinned-package` (medium): `npx`, `bunx`, `pnpm dlx`, `yarn dlx`, `uvx`, or `deno` will launch a package with no version, or with a floating tag such as `@latest`. Pin a version. `uvx` accepts `name==version`.
- `duplicate-server` (medium): two entries launch the same command and arguments, or share a URL. Remove the extra one. `duplicate-name` (low) means the same name is defined twice with different commands; clients keep one of them.
- `config-invalid` (medium): the file or the server entry could not be parsed, or it has neither a command nor a URL.
- `config-ambiguous` (low): both `command` and `url` are set.
- `missing-type` (low): a URL entry has no `type`. Claude Code skips it. Set `"type": "http"` or `"sse"`.
- `missing-annotation` (medium, `--live` only): a tool omits `readOnlyHint`, or omits `destructiveHint` when it is not read-only. The spec defaults those to false and true, so clients treat the tool as a destructive write. Annotations are hints, not enforcement.
- `destructive-tool` (medium, `--live` only): the name or description suggests a destructive action and `readOnlyHint` is not true. Confirm that is intended, and set the hints.
- `annotation-mismatch` (medium, `--live` only): `readOnlyHint` is true but the name suggests a destructive action. Do not trust the hint on its own.
- `live-failed` (medium): the process did not return `tools/list` before the timeout. The static findings still stand. A failure here is not a clean result.

Skill rules:

- `remote-exec` (high): the skill tells the agent to fetch a remote script and run it in a shell. Remove that instruction.
- `credential-exfil` (high): the skill tells the agent to read credential material and send it elsewhere. Remove it.
- `credential-read` (medium): the skill tells the agent to open credential files. Remove it unless the user explicitly asked for that and the skill says so narrowly.
- `hidden-text` (high): zero-width or direction-override characters. Show the code points from the finding (for example `U+200B`) and delete those characters. Do not copy the raw line back into the file without revealing them.
- `homoglyph` (medium): a token mixes ASCII with lookalike letters. Replace the token with plain ASCII if it is meant to be a command or identifier.
- `oversized-skill` (medium, high above 80,000 characters): shorten the skill. The token figure is the string length divided by 4, not a model tokenizer.
- `skill-unreadable` (medium): the file could not be read.

## After a run

Fix the config or the skill, then run the same command again. Do not edit this tool to hide a finding, and do not delete a finding from the report by hand. A report with no high findings can still have medium and low findings worth fixing.

A run with no findings is not proof that a server is safe. The checks are name and text heuristics. `--live` lists tools; it does not call them, and it does not inspect the server's code.

When the user wants this in CI, run `npx mcp-preflight --json` and fail the job on exit code 1. Use `--only` with explicit `--config` and `--skills` paths so the job does not read a developer's home directory.
