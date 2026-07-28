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
  result: {
    action: 'set_value_ref',
    windowHandle: 42,
    targetRef: 'uia:1.2.3',
    valueSet: true,
    currentValue: 'top-secret-value',
    postObservation: {
      elements: [{ name: 'Password', value: 'top-secret-value' }],
    },
  },
  verification: {
    status: status === 'completed' ? 'passed' : 'failed',
    evidence: { expected: 'top-secret-value', actual: 'top-secret-value' },
  },
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
    const contents = await readFile(path, 'utf8');
    const lines = contents.trim().split(/\r?\n/);
    assert.equal(lines.length, 2);
    assert.equal(contents.includes('top-secret-value'), false);
    assert.equal(contents.includes('postObservation'), false);
    const saved = JSON.parse(lines[0]);
    assert.deepEqual(saved.result, {
      action: 'set_value_ref',
      windowHandle: 42,
      targetRef: 'uia:1.2.3',
      valueSet: true,
    });
    assert.deepEqual(saved.verification, { status: 'passed' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('full detail mode is explicit and preserves the original receipt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kv-receipts-full-'));
  try {
    const path = join(dir, 'receipts.jsonl');
    const store = new ReceiptStore(path, 'full');
    await store.append(receipt('full-1'));
    const contents = await readFile(path, 'utf8');
    assert.equal(contents.includes('top-secret-value'), true);
    assert.equal(contents.includes('postObservation'), true);
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
