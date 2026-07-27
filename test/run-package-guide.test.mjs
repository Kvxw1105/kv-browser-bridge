import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('imports a KV_RUN_PACKAGE_V1 into an evidence-linked guide', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-guide-'));
  try {
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ version: 1, run: { id: 'run-1' }, artifacts: [] }));
    writeFileSync(join(root, 'events.jsonl'), JSON.stringify({ id: 'event-1', method: 'browser_get_tabs' }) + '\n');
    writeFileSync(join(root, 'recipe-draft.json'), JSON.stringify({ intent: 'Read dashboard metrics', steps: [{ id: 'step-1', action: 'get_text', description: 'Read the metric.' }] }));
    const result = spawnSync(process.execPath, ['scripts/import-kv-run-package.mjs', root], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(root, 'guide', 'article.md')), true);
    assert.match(result.stdout, /"status": "pass"/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
