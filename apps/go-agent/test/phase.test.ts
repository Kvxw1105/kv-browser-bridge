import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoEngine } from '../src/core.js';
import { MemoryStorage } from '../src/storage.js';
import type { PageAdapter, Platform } from '../src/types.js';

class FakeAdapter implements PageAdapter {
  platform: Platform = 'chatgpt';
  busy = false;
  text = '';
  typed: string[] = [];

  isBusy(): Promise<boolean> {
    return Promise.resolve(this.busy);
  }

  lastText(): Promise<string> {
    return Promise.resolve(this.text);
  }

  async typeText(text: string): Promise<boolean> {
    this.typed.push(text);
    return true;
  }

  send(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test('phase 流转：waiting -> 生成 -> 冷却，并在冷却后推进', async () => {
  const adapter = new FakeAdapter();
  const engine = new GoEngine(adapter, { status() {}, notify() {} }, new MemoryStorage(), {
    config: {
      finishConfirmMs: 100,
      idleThresholdMs: 150,
      cooldownMinMs: 250,
      cooldownMaxMs: 250,
      pollMinMs: 30,
      pollMaxMs: 40,
      injectProtocol: false,
      maxRounds: 5,
    },
  });
  await engine.start({});
  assert.equal(engine.getState().phase, 'waiting');

  adapter.busy = true;
  adapter.text = '模型开始回复……';
  await sleep(120);
  adapter.busy = false; // 生成结束，应立即识别完成
  await sleep(100);
  assert.ok(adapter.typed.length >= 1, '应已自动发送推进语');
  assert.equal(engine.getState().round, 1);
  assert.ok(['cooldown', 'waiting'].includes(engine.getState().phase), 'phase=' + engine.getState().phase + ' round=' + engine.getState().round + ' typed=' + adapter.typed.length);
  assert.ok(engine.getState().nextActionAt > Date.now() - 500, 'nextActionAt 应指向未来');

  await engine.stop('测试停止');
  assert.equal(engine.getState().phase, 'stopped');
  assert.equal(engine.getState().lastStopReason, '测试停止');
});

test('关键词命中节点时自动停止', async () => {
  const adapter = new FakeAdapter();
  const engine = new GoEngine(adapter, { status() {}, notify() {} }, new MemoryStorage(), {
    config: {
      idleThresholdMs: 100,
      cooldownMinMs: 200,
      cooldownMaxMs: 200,
      pollMinMs: 30,
      pollMaxMs: 40,
      injectProtocol: false,
      maxRounds: 5,
    },
  });
  await engine.start({});
  adapter.busy = true;
  adapter.text = '以上全部完成，可以验收了。';
  await sleep(120);
  adapter.busy = false;
  await sleep(400);
  assert.equal(engine.getState().running, false);
  assert.ok(engine.getState().lastStopReason.includes('节点'));
});

test('生成结束立即识别简短回复并停止（不等 30s）', async () => {
  const adapter = new FakeAdapter();
  const engine = new GoEngine(adapter, { status() {}, notify() {} }, new MemoryStorage(), {
    config: {
      finishConfirmMs: 100,
      idleThresholdMs: 30000,
      cooldownMinMs: 5000,
      cooldownMaxMs: 5000,
      pollMinMs: 30,
      pollMaxMs: 40,
      injectProtocol: false,
      maxRounds: 5,
    },
  });
  await engine.start({});
  adapter.busy = true;
  adapter.text = '【任务完成】交付如下';
  await sleep(120);
  adapter.busy = false;
  await sleep(400);
  assert.equal(engine.getState().running, false, '简短回复+完成标记应立即停止');
  assert.ok(engine.getState().lastStopReason.includes('节点'));
});
