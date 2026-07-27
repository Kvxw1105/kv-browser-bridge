import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { KvRuntime } from '../dist/runtime.js';

test('shadow runtime writes a redacted run package with recipe and artifact evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-runtime-'));
  try {
    const image = join(root, 'source.png');
    writeFileSync(image, 'not-a-real-png');
    const runtime = new KvRuntime({ root, mode: 'shadow', now: () => '2026-07-28T00:00:00.000Z' });
    const runId = runtime.latestRunId();
    const eventId = runtime.recordRequest('browser_click', { tabId: 7, text: 'secret title', selector: '#save' }, 'non_idempotent_write', 7);
    runtime.recordResult(eventId, { clicked: true });
    runtime.addArtifact(eventId, 'screenshot', image);
    runtime.saveRecipeDraft({ id: 'recipe-1', version: 1, steps: [{ id: 'step-1', action: 'click' }], checkpoints: [] });
    runtime.finishRun();
    const packageInfo = runtime.exportRunPackage(runId, join(root, 'package'));
    runtime.close();
    assert.deepEqual(packageInfo.files.slice(0, 4), ['manifest.json', 'events.jsonl', 'recipe-draft.json', 'result.json']);
    assert.match(readFileSync(join(root, 'package', 'events.jsonl'), 'utf8'), /\[redacted\]/);
    assert.equal(JSON.parse(readFileSync(join(root, 'package', 'recipe-draft.json'), 'utf8')).id, 'recipe-1');
    assert.equal(JSON.parse(readFileSync(join(root, 'package', 'manifest.json'), 'utf8')).artifacts[0].path.startsWith('artifacts/'), true);
    assert.equal(JSON.parse(readFileSync(join(root, 'package', 'result.json'), 'utf8')).status, 'completed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runtime snapshots a pre-migration database before adding its schema', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-runtime-migration-'));
  try {
    const path = join(root, 'runtime.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec('CREATE TABLE legacy_data (value TEXT); INSERT INTO legacy_data VALUES (\'keep\');');
    legacy.close();
    const runtime = new KvRuntime({ root, mode: 'legacy' });
    runtime.close();
    assert.equal(existsSync(join(root, 'runtime.sqlite.before-v1.bak')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('recipe review persists variables and starts an independent replay run', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-runtime-review-'));
  try {
    const runtime = new KvRuntime({ root, mode: 'shadow' });
    runtime.saveRecipeDraft({ id: 'recipe-review', version: 1, steps: [{ id: 'step-1', action: 'click' }], checkpoints: [] });
    const reviewed = runtime.reviewRecipeDraft('recipe-review', { type: 'variable', stepIds: ['step-1'], name: 'date_range' });
    assert.equal(reviewed.steps[0].variable, 'date_range');
    const replay = runtime.startReplay('recipe-review');
    assert.match(replay.runId, /^run-/);
    assert.equal(replay.recipe.steps[0].variable, 'date_range');
    runtime.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shadow runtime resumes event recording after a replay run completes', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-runtime-resume-'));
  try {
    const runtime = new KvRuntime({ root, mode: 'shadow' });
    runtime.saveRecipeDraft({ id: 'recipe-resume', version: 1, steps: [{ id: 'step-1', action: 'get_url' }], checkpoints: [] });
    const replay = runtime.startReplay('recipe-resume');
    runtime.finishRun();
    const shadowRun = runtime.resumeShadowRun();
    const eventId = runtime.recordRequest('browser_get_url', { tabId: 7 }, 'read', 7);
    runtime.recordResult(eventId, { url: 'https://example.test/' });
    runtime.finishRun();
    const packageInfo = runtime.exportRunPackage(shadowRun, join(root, 'package'));
    runtime.close();
    assert.notEqual(shadowRun, replay.runId);
    assert.match(readFileSync(join(packageInfo.directory, 'events.jsonl'), 'utf8'), /browser_get_url/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
