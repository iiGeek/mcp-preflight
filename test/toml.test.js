'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseMcpServers } = require('../lib/toml');

describe('parseMcpServers', () => {
  it('reads the example Codex config and ignores other tables', () => {
    const text = fs.readFileSync(path.join(__dirname, '..', 'fixtures/example/.codex/config.toml'), 'utf8');
    const parsed = parseMcpServers(text);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.servers.fetch.command, 'npx');
    assert.deepEqual(parsed.servers.fetch.args, ['-y', '@example/fetch-mcp@2.0.0']);
    assert.equal(parsed.servers.fetch.env.FETCH_TOKEN, '${FETCH_TOKEN}');
    assert.equal(parsed.servers.model, undefined);
  });

  it('reads quoted names, inline tables, and a server that follows an unsupported value', () => {
    const parsed = parseMcpServers(`
when = 1979-05-27T07:32:00Z

[mcp_servers.fetch]
command = "uvx"
args = [
  "pkg==1.2.3",
]
env = { "API_KEY" = "\${API_KEY}" }

[mcp_servers."my.server"]
url = "https://example.com/mcp"
bearer_token_env_var = "MY_TOKEN"
`);
    assert.equal(parsed.errors.length, 0);
    assert.equal(parsed.servers.fetch.command, 'uvx');
    assert.deepEqual(parsed.servers.fetch.args, ['pkg==1.2.3']);
    assert.equal(parsed.servers.fetch.env.API_KEY, '${API_KEY}');
    assert.equal(parsed.servers['my.server'].url, 'https://example.com/mcp');
    assert.equal(parsed.servers['my.server'].bearer_token_env_var, 'MY_TOKEN');
  });
});
