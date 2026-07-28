import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEX_BLOCK_START,
  CODEX_BLOCK_END,
  hasCodexBlock,
  removeCodexBlock,
  renderCodexBlock,
  upsertCodexBlock,
} from '../dist/codex-config.js';

test('appends a managed Codex block without changing existing settings', () => {
  const original = 'model = "gpt-5"\n[mcp_servers.other]\ncommand = "other"\n';
  const edit = upsertCodexBlock(original, 'C:\\kv\\computer-server.js', 'C:\\node\\node.exe');
  assert.equal(edit.changed, true);
  assert.match(edit.content, /^model = "gpt-5"/);
  assert.match(edit.content, /\[mcp_servers\.other\]/);
  assert.match(edit.content, new RegExp(CODEX_BLOCK_START));
  assert.match(edit.content, /command = "C:\\\\node\\\\node\.exe"/);
  assert.equal(hasCodexBlock(edit.content), true);
});

test('updates only the managed block and is idempotent', () => {
  const first = upsertCodexBlock('', 'C:\\old\\computer-server.js', 'C:\\node\\node.exe').content;
  const second = upsertCodexBlock(first, 'D:\\new\\computer-server.js', 'D:\\node\\node.exe');
  assert.equal((second.content.match(new RegExp(CODEX_BLOCK_START, 'g')) ?? []).length, 1);
  assert.equal((second.content.match(new RegExp(CODEX_BLOCK_END, 'g')) ?? []).length, 1);
  assert.match(second.content, /D:\\\\new\\\\computer-server\.js/);
  assert.doesNotMatch(second.content, /C:\\\\old/);
  assert.equal(upsertCodexBlock(second.content, 'D:\\new\\computer-server.js', 'D:\\node\\node.exe').changed, false);
});

test('refuses to overwrite an unmanaged same-name table', () => {
  const source = '[mcp_servers.kv-computer-use]\ncommand = "custom"\n';
  assert.throws(() => upsertCodexBlock(source, 'server.js', 'node.exe'), /Refusing to replace unmanaged/);
});

test('removes only the managed block', () => {
  const source = `model = "gpt-5"\n\n${renderCodexBlock('server.js', 'node.exe')}\n`;
  const edit = removeCodexBlock(source);
  assert.equal(edit.changed, true);
  assert.equal(edit.installed, false);
  assert.equal(edit.content, 'model = "gpt-5"\n');
});

test('rejects malformed managed markers', () => {
  assert.throws(() => hasCodexBlock(`${CODEX_BLOCK_START}\n${CODEX_BLOCK_START}\n${CODEX_BLOCK_END}\n`), /malformed or duplicate/);
});
