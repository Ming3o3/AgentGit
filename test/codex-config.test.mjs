import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { codexMcpConfig } from '../src/codex-config.mjs';

test('generates a project-scoped Codex MCP config without writing configuration files', () => {
  const workspace = path.resolve('/tmp/agentgit workspace');
  const config = codexMcpConfig({ repo: workspace, agentId: 'coder', serverPath: '/opt/agentgit/src/mcp-server.mjs' });
  assert.match(config, /\[mcp_servers\.agentgit\]/);
  assert.match(config, /command = "node"/);
  assert.match(config, /"--repo", "\/tmp\/agentgit workspace", "--agent", "coder"/);
  assert.match(config, /cwd = "\/tmp\/agentgit workspace"/);
});

test('requires an explicit target repository and agent identity', () => {
  assert.throws(() => codexMcpConfig({ agentId: 'coder' }), /repo is required/);
  assert.throws(() => codexMcpConfig({ repo: '/tmp/test' }), /agentId is required/);
});
