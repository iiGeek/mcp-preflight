'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { audit } = require('../lib/run');

function writeFile(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function mcp(name) {
  return JSON.stringify({
    mcpServers: { [name]: { command: 'node', args: [`${name}.js`] } },
  });
}

describe('discovery', () => {
  it('reads project and home configs and skills for the usual clients', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-preflight-'));
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');

    writeFile(path.join(project, '.mcp.json'), mcp('project-claude'));
    writeFile(path.join(project, '.cursor', 'mcp.json'), mcp('project-cursor'));
    writeFile(
      path.join(project, '.vscode', 'mcp.json'),
      JSON.stringify({ servers: { projectVscode: { command: 'node', args: ['vscode.js'] } } })
    );
    writeFile(path.join(project, '.windsurf', 'mcp_config.json'), mcp('project-windsurf'));
    writeFile(
      path.join(project, '.codex', 'config.toml'),
      '[mcp_servers.project_codex]\ncommand = "node"\nargs = ["codex.js"]\n'
    );
    writeFile(path.join(project, '.claude', 'skills', 'proj', 'SKILL.md'), '---\nname: proj\n---\n\nHello\n');
    writeFile(path.join(project, '.agents', 'skills', 'agent', 'SKILL.md'), '---\nname: agent\n---\n\nHello\n');

    writeFile(path.join(home, '.claude.json'), JSON.stringify({
      mcpServers: { userDocs: { command: 'node', args: ['docs.js'] } },
      projects: { '/work/demo': { mcpServers: { localGit: { command: 'uvx', args: ['git'] } } } },
    }));
    writeFile(path.join(home, '.config', 'Claude', 'claude_desktop_config.json'), mcp('desktop'));
    writeFile(path.join(home, '.cursor', 'mcp.json'), mcp('home-cursor'));
    writeFile(path.join(home, '.config', 'Code', 'User', 'mcp.json'), JSON.stringify({
      servers: { homeVscode: { command: 'node', args: ['home-vscode.js'] } },
    }));
    writeFile(path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), mcp('home-windsurf'));
    writeFile(path.join(home, '.codex', 'config.toml'), 'model = "none"\n');
    writeFile(path.join(home, '.claude', 'skills', 'personal', 'SKILL.md'), '---\nname: personal\n---\n\nHello\n');

    const result = await audit({ cwd: project, home, platform: 'linux' });
    const clients = result.configs.map((cfg) => cfg.client);
    assert.deepEqual(clients, [
      'claude-code',
      'cursor',
      'vscode',
      'windsurf',
      'codex',
      'claude-desktop',
      'claude-code',
      'cursor',
      'vscode',
      'windsurf',
    ]);
    assert.equal(result.servers.some((server) => server.name === 'localGit' && server.scope === 'local'), true);
    assert.equal(result.servers.some((server) => server.name === 'projectVscode'), true);
    assert.deepEqual(
      result.skills.map((skill) => skill.name).sort(),
      ['agent', 'personal', 'proj']
    );

    const only = await audit({
      cwd: project,
      home,
      platform: 'linux',
      only: true,
      configs: [path.join(project, '.mcp.json')],
    });
    assert.deepEqual(only.servers.map((server) => server.name), ['project-claude']);
    assert.equal(only.skills.length, 0);
  });

  it('uses platform config paths for Claude Desktop and VS Code', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-preflight-plat-'));
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    const desktop = path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    const vscode = path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
    writeFile(desktop, mcp('mac-desktop'));
    writeFile(vscode, JSON.stringify({ servers: { macVscode: { command: 'node', args: ['v.js'] } } }));
    const mac = await audit({ cwd: project, home, platform: 'darwin' });
    assert.deepEqual(mac.servers.map((server) => server.name).sort(), ['mac-desktop', 'macVscode']);

    const appData = path.join(root, 'AppData');
    const winHome = path.join(root, 'winhome');
    const winProject = path.join(root, 'winproj');
    fs.mkdirSync(winProject);
    writeFile(
      path.join(appData, 'Claude', 'claude_desktop_config.json'),
      mcp('win-desktop')
    );
    const win = await audit({
      cwd: winProject,
      home: winHome,
      platform: 'win32',
      env: { APPDATA: appData },
    });
    assert.deepEqual(win.servers.map((server) => server.name), ['win-desktop']);
  });
});
