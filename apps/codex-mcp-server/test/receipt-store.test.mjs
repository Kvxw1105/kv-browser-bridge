import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReceiptStore } from '../dist/receipt-store.js';

const receipt = (actionId, status = 'completed') => ({
  protocolVersion: 1,
  actionId,
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  driver: 'windows-uia',
  status,
  verification: { status: status === 'completed' ? 'passed' : 'failed' },
});

test('persists, lists, and finds action receipts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kv-receipts-'));
  try {
    const path = join(dir, 'receipts.jsonl');
    const store = new ReceiptStore(path);
    await store.append(receipt('a-1'));
    await store.append(receipt('a-2', 'failed'));
    const recent = await store.recent(10);
    assert.deepEqual(recent.map((item) => item.actionId), ['a-2', 'a-1']);
    assert.equal((await store.find('a-1')).status, 'completed');
    assert.equal(await store.find('missing'), undefined);
    const lines = (await readFile(path, 'utf8')).trim().split(/\r?\n/);
    assert.equal(lines.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('returns an empty list when the log does not exist', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kv-receipts-empty-'));
  try {
    const store = new ReceiptStore(join(dir, 'missing.jsonl'));
    assert.deepEqual(await store.recent(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
