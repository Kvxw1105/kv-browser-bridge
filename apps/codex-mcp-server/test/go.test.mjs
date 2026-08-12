import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoController, defaultPlatformSelectors } from '../dist/go.js';
import { GoEngine } from '../../go-agent/dist/core.js';
import { FileStorage } from '../../go-agent/dist/file-storage.js';

function fakeInvoke(overrides = {}) {
  const calls = [];
  const invoke = async (method, params = {}) => {
    calls.push([method, params]);
    if (method === 'browser_get_url') return { url: overrides.url ?? 'https://chatgpt.com/c/abc123' };
    if (method === 'browser_evaluate') return { result: { value: overrides.evaluateValue ?? '' } };
    if (method === 'browser_type' || method === 'browser_press' || method === 'browser_switch_tab') return {};
    if (overrides[method]) return overrides[method](params);
    throw new Error(`unexpected invoke ${method}`);
  };
  return { invoke, calls };
}

function hooks() {
  const statuses = [];
  const notifications = [];
  return {
    status: (text) => statuses.push(text),
    notify: (text) => notifications.push(text),
    statuses,
    notifications,
  };
}

test('controller start/status/stop lifecycle on a chatgpt tab', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-go-ctrl-'));
  const { invoke, calls } = fakeInvoke({ url: 'https://chatgpt.com/c/abc123' });
  process.env.GO_RUNS_DIR = root;
  const controller = new GoController(invoke, () => undefined);
  const before = await controller.status(42);
  assert.equal(before.ok, false);
  assert.match(before.error ?? '', /no active GO entry/);

  const started = await controller.start(42, { maxRounds: 3, keyword: 'DONE', injectProtocol: false });
  assert.equal(started.ok, true);
  assert.equal(started.running, true);
  assert.equal(started.platform, 'chatgpt');
  assert.equal(started.conversationKey, 'gpt-abc123');
  assert.equal(started.maxRounds, 3);
  // start switches the tab active and reads the platform/url through the bridge
  assert.ok(calls.some(([m]) => m === 'browser_switch_tab'));

  const status = await controller.status(42);
  assert.equal(status.running, true);
  assert.equal(status.state.phase, 'waiting');

  const stopped = await controller.stop(42);
  assert.equal(stopped.running, false);
  assert.equal(stopped.state.phase, 'stopped');
  await controller.stop(42); // idempotent
});

test('platform detection maps hostname to chatgpt vs deepseek', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-go-platform-'));
  process.env.GO_RUNS_DIR = root;
  const chatgpt = new GoController(fakeInvoke({ url: 'https://chatgpt.com/c/x' }).invoke, () => undefined);
  const c = await chatgpt.resolve(7);
  assert.equal(c.platform, 'chatgpt');
  assert.equal(c.conversationKey, 'gpt-x');
  const deepseek = new GoController(fakeInvoke({ url: 'https://chat.deepseek.com/a/chat/s/xyz' }).invoke, () => undefined);
  const d = await deepseek.resolve(8);
  assert.equal(d.platform, 'deepseek');
  assert.equal(d.conversationKey, 'ds-xyz');
});

test('default platform selectors are centralized and complete', () => {
  const selectors = defaultPlatformSelectors();
  for (const platform of ['chatgpt', 'deepseek']) {
    const s = selectors[platform];
    assert.ok(s.input.length > 0, `${platform} input selector`);
    assert.ok(s.busyExpr.includes('querySelector'), `${platform} busy expr`);
    assert.ok(s.lastExpr.includes('querySelector'), `${platform} last expr`);
    assert.ok(Array.isArray(s.riskTexts) && s.riskTexts.length > 0, `${platform} risk texts`);
  }
});

test('engine stops itself after consecutive bridge read failures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-go-fail-'));
  mkdirSync(join(root, 'identity-a', 'engine'), { recursive: true });
  const failed = { count: 0 };
  const adapter = {
    platform: 'deepseek',
    recentFailureCount: () => failed.count,
    isBusy: async () => { failed.count += 1; return false; },
    lastText: async () => { failed.count += 1; return ''; },
    typeText: async () => false,
    send: async () => false,
  };
  const engine = new GoEngine(adapter, hooks(), new FileStorage(join(root, 'identity-a', 'engine')), {
    config: { pollMinMs: 10, pollMaxMs: 15, bridgeFailureStopCount: 3 },
  });
  await engine.start({ maxRounds: 10, injectProtocol: false });
  // Let the polling loop hit the failure threshold.
  const deadline = Date.now() + 2000;
  while (engine.getState().running && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(engine.getState().running, false);
  assert.match(engine.getState().lastStopReason, /桥连接中断/);
  engine.stop('cleanup');
});

test('atCheckpoint is case-insensitive and honors done markers', async () => {
  const { atCheckpoint } = await import('../../go-agent/dist/core.js');
  const { createDefaultConfig } = await import('../../go-agent/dist/config.js');
  const config = { ...createDefaultConfig(), keyword: 'TASK_COMPLETE' };
  assert.equal(atCheckpoint('... TASK_COMPLETE ...', config), true);
  assert.equal(atCheckpoint('... task_complete ...', config), true);
  const lower = { ...createDefaultConfig(), keyword: '' };
  assert.equal(atCheckpoint('这是【任务完成】的最终交付', lower), true);
  assert.equal(atCheckpoint('还在继续推进', lower), false);
});

test('default selectors survive JSON round-trip (no template literals with backticks)', () => {
  const roundTripped = JSON.parse(JSON.stringify(defaultPlatformSelectors()));
  assert.equal(roundTripped.chatgpt.busyExpr, defaultPlatformSelectors().chatgpt.busyExpr);
  assert.equal(roundTripped.deepseek.lastExpr, defaultPlatformSelectors().deepseek.lastExpr);
});
