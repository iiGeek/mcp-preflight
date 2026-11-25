'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { checkServers } = require('../lib/checks');

const ctx = { cwd: '/proj', home: '/home/dev', platform: 'linux' };

function server(overrides) {
  return {
    name: 'demo',
    client: 'cursor',
    configPath: '/proj/.mcp.json',
    scope: 'project',
    projectPath: null,
    transport: 'stdio',
    command: 'node',
    args: ['server.js'],
    env: {},
    headers: {},
    envHttpHeaders: {},
    url: null,
    cwd: null,
    disabled: false,
    bearerToken: null,
    bearerTokenEnvVar: null,
    ambiguous: false,
    missingType: false,
    ...overrides,
  };
}

function rules(findings) {
  return findings.map((finding) => finding.rule);
}

describe('server checks', () => {
  it('flags literal secrets and ignores references and placeholders', () => {
    const secret = 'sk-test-abcdefghijklmnopqrstuvwxyz';
    const findings = checkServers(
      [
        server({
          env: {
            API_KEY: secret,
            NOTES_TOKEN: '${NOTES_TOKEN}',
            AUTHOR_NAME: 'not-a-credential',
            PASSWORD: 'abc',
          },
          headers: { Authorization: 'Bearer ${INTRANET_TOKEN}' },
        }),
      ],
      ctx
    );
    const inline = findings.filter((finding) => finding.rule === 'inline-secret');
    assert.equal(inline.length, 1);
    assert.equal(inline[0].location, 'env.API_KEY');
    assert.equal(inline[0].message.includes(secret), false);
    assert.equal(rules(findings).includes('inline-secret'), true);
  });

  it('flags a password embedded in a URL without echoing it', () => {
    const findings = checkServers(
      [
        server({
          transport: 'http',
          command: null,
          url: 'postgresql://app:supersecretvalue@db.internal/app',
        }),
      ],
      ctx
    );
    const inline = findings.find((finding) => finding.rule === 'inline-secret');
    assert.ok(inline);
    assert.equal(inline.message.includes('supersecretvalue'), false);
  });

  it('flags a literal bearer token and a token pasted into bearer_token_env_var', () => {
    const findings = checkServers(
      [
        server({
          bearerToken: 'literal-token-value',
          bearerTokenEnvVar: 'sk-test-abcdefghijklmnopqrstuvwxyz',
        }),
      ],
      ctx
    );
    const locations = findings.filter((finding) => finding.rule === 'inline-secret').map((finding) => finding.location);
    assert.deepEqual(locations.sort(), ['bearer_token', 'bearer_token_env_var']);
  });

  it('flags credential-shaped arguments', () => {
    const findings = checkServers(
      [server({ args: ['--token', 'sk-test-abcdefghijklmnopqrstuvwxyz'] })],
      ctx
    );
    assert.equal(findings.some((finding) => finding.rule === 'inline-secret'), true);
  });

  it('flags filesystem root and home, and ignores a project subdirectory', () => {
    const root = checkServers([server({ args: ['/'] })], ctx);
    const home = checkServers([server({ args: ['/home/dev'] })], ctx);
    const ref = checkServers([server({ args: ['${userHome}'] })], ctx);
    const project = checkServers([server({ args: ['/home/dev/proj'] })], ctx);
    assert.equal(root.some((finding) => finding.rule === 'broad-filesystem'), true);
    assert.equal(home.some((finding) => finding.rule === 'broad-filesystem'), true);
    assert.match(ref.find((finding) => finding.rule === 'broad-filesystem').message, /home directory/);
    assert.equal(project.some((finding) => finding.rule === 'broad-filesystem'), false);
  });

  it('flags Docker mounts of / and the home directory', () => {
    const findings = checkServers(
      [
        server({
          command: 'docker',
          args: ['run', '-v', '/:/host', '--mount', 'type=bind,source=/home/dev,target=/work', 'image'],
        }),
      ],
      ctx
    );
    const broad = findings.filter((finding) => finding.rule === 'broad-filesystem');
    assert.equal(broad.length, 2);
    assert.ok(broad.some((finding) => /filesystem root/.test(finding.message)));
    assert.ok(broad.some((finding) => /home directory/.test(finding.message)));
  });

  it('flags a directory env value of / and ignores PATH', () => {
    const findings = checkServers(
      [server({ env: { ALLOWED_DIRS: '/', PATH: '/usr/bin:/bin' } })],
      ctx
    );
    const broad = findings.filter((finding) => finding.rule === 'broad-filesystem');
    assert.equal(broad.length, 1);
    assert.equal(broad[0].location, 'env.ALLOWED_DIRS');
  });

  it('treats a Windows drive root as the filesystem root', () => {
    const findings = checkServers(
      [server({ args: ['C:\\'] })],
      { ...ctx, platform: 'win32', home: 'C:\\Users\\dev' }
    );
    assert.equal(findings.some((finding) => finding.rule === 'broad-filesystem'), true);
  });

  it('flags unpinned npx, uvx, and pnpm packages and accepts pins and local paths', () => {
    const cases = [
      { command: 'npx', args: ['-y', 'mcp-server-search'], hit: true },
      { command: 'npx', args: ['-y', '@scope/pkg@latest'], hit: true },
      { command: 'npx', args: ['-y', '@scope/pkg@1.2.3'], hit: false },
      { command: 'npx', args: ['-y', './server.js'], hit: false },
      { command: 'uvx', args: ['mcp-server-git'], hit: true },
      { command: 'uvx', args: ['mcp-server-docs==0.3.1'], hit: false },
      { command: 'pnpm', args: ['dlx', 'some-mcp'], hit: true },
    ];
    for (const item of cases) {
      const findings = checkServers([server({ command: item.command, args: item.args })], ctx);
      assert.equal(
        findings.some((finding) => finding.rule === 'unpinned-package'),
        item.hit,
        `${item.command} ${item.args.join(' ')}`
      );
    }
  });

  it('flags an unpinned package inside a shell string and not a single-quoted variable', () => {
    const unpinned = checkServers(
      [server({ command: 'bash', args: ['-lc', 'npx -y mcp-tools'] })],
      ctx
    );
    assert.equal(unpinned.some((finding) => finding.rule === 'unpinned-package'), true);
    assert.equal(unpinned.some((finding) => finding.rule === 'shell-interpolation'), false);

    const quoted = checkServers(
      [server({ command: 'bash', args: ['-lc', "echo '$HOME'"] })],
      ctx
    );
    assert.equal(quoted.some((finding) => finding.rule === 'shell-interpolation'), false);
    assert.equal(quoted.some((finding) => finding.rule === 'broad-filesystem'), false);
  });

  it('flags shell interpolation, including cmd variables, and ignores a direct exec', () => {
    const expanded = checkServers(
      [server({ command: 'bash', args: ['-lc', 'echo connected as $USER'] })],
      ctx
    );
    const substituted = checkServers(
      [server({ command: 'sh', args: ['-c', 'echo $(id)'] })],
      ctx
    );
    const cmd = checkServers(
      [server({ command: 'cmd', args: ['/c', 'echo %USERPROFILE%'] })],
      ctx
    );
    const direct = checkServers([server({ command: 'node', args: ['server.js'] })], ctx);
    assert.equal(expanded.some((finding) => finding.severity === 'high' && finding.rule === 'shell-interpolation'), true);
    assert.match(substituted.find((finding) => finding.rule === 'shell-interpolation').message, /command substitution/);
    assert.equal(cmd.some((finding) => finding.rule === 'shell-interpolation'), true);
    assert.equal(direct.length, 0);
  });

  it('classifies remote and loopback cleartext URLs', () => {
    const remote = checkServers(
      [server({ transport: 'http', command: null, url: 'http://intranet.example.com/mcp' })],
      ctx
    );
    const loop = checkServers(
      [server({ transport: 'http', command: null, url: 'http://127.0.0.1:3000/mcp' })],
      ctx
    );
    const secure = checkServers(
      [server({ transport: 'http', command: null, url: 'https://example.com/mcp' })],
      ctx
    );
    assert.equal(remote.find((finding) => finding.rule === 'cleartext-remote').severity, 'high');
    assert.equal(loop.find((finding) => finding.rule === 'loopback-http').severity, 'low');
    assert.equal(secure.some((finding) => finding.rule === 'cleartext-remote' || finding.rule === 'loopback-http'), false);
  });

  it('reports duplicate launches and shadowed names separately', () => {
    const same = checkServers(
      [
        server({ name: 'files', command: 'npx', args: ['-y', 'pkg@1.0.0'] }),
        server({
          name: 'files',
          command: '/usr/local/bin/npx',
          args: ['-y', 'pkg@1.0.0'],
          configPath: '/proj/.cursor/mcp.json',
        }),
      ],
      ctx
    );
    assert.deepEqual(rules(same), ['duplicate-server']);

    const shadow = checkServers(
      [
        server({ name: 'files', args: ['a.js'], configPath: '/proj/a.json' }),
        server({ name: 'files', args: ['b.js'], configPath: '/proj/b.json' }),
      ],
      ctx
    );
    assert.deepEqual(rules(shadow), ['duplicate-name']);
  });

  it('flags a URL with no type and an entry that sets both command and url', () => {
    const findings = checkServers(
      [
        server({ transport: 'http', command: null, url: 'https://example.com/mcp', missingType: true }),
        server({ url: 'https://example.com/other', ambiguous: true }),
      ],
      ctx
    );
    assert.equal(findings.some((finding) => finding.rule === 'missing-type'), true);
    assert.equal(findings.some((finding) => finding.rule === 'config-ambiguous'), true);
  });
});
