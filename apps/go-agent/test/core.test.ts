import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atCheckpoint, extractSummary, pickNudge } from '../src/core.js';
import { createDefaultConfig } from '../src/config.js';
import { TemplateDecisionEngine } from '../src/decision.js';
import { MemoryStorage } from '../src/storage.js';

const cfg = createDefaultConfig();

test('atCheckpoint 命中默认完成词', () => {
  assert.equal(atCheckpoint('以上是全部内容，已完成。', cfg), true);
  assert.equal(atCheckpoint('正在继续推进中。', cfg), false);
});

test('atCheckpoint 识别【任务完成】标记', () => {
  assert.equal(atCheckpoint('...\n【任务完成】\n最终交付如下', cfg), true);
});

test('atCheckpoint 使用自定义关键词', () => {
  const c = { ...cfg, keyword: '验收点' };
  assert.equal(atCheckpoint('已到验收点，请检查。', c), true);
  assert.equal(atCheckpoint('已到检查点。', c), false);
});

test('extractSummary 提取摘要块', () => {
  const text = '正文内容\n【进度摘要】\n已完成：A\n未完成：B\n下一步：C';
  const out = extractSummary(text, cfg.summaryMarker);
  assert.ok(out.startsWith('【进度摘要】'));
  assert.ok(out.includes('已完成：A'));
  assert.equal(extractSummary('没有摘要', cfg.summaryMarker), '');
});

test('pickNudge 不连续重复同一句', () => {
  const pool = ['继续', '接着推进', '别停'];
  for (let i = 0; i < 20; i++) {
    const first = pickNudge(pool, '');
    const second = pickNudge(pool, first);
    assert.notEqual(first, second);
  }
});

test('TemplateDecisionEngine 回退 null（规则拿不准交模板池）', async () => {
  const engine = new TemplateDecisionEngine();
  const result = await engine.decide({ goal: 'x', summary: 'y', previousQuestion: 'z', round: 1 }, { config: cfg, state: {} as never });
  assert.equal(result, null);
});

test('MemoryStorage 保存/读取状态', async () => {
  const s = new MemoryStorage();
  await s.saveState({ running: true, round: 3, nudgeCount: 1, startedAt: 123, lastSummary: 's', goal: '写一个 CLI' });
  const loaded = await s.loadState();
  assert.equal(loaded?.round, 3);
  assert.equal(loaded?.lastSummary, 's');
  assert.equal(loaded?.goal, '写一个 CLI');
});

test('busy stall is not counted as a completed round', async () => {
  const { GoEngine } = await import('../src/core.js');
  const { createDefaultConfig } = await import('../src/config.js');
  const { MemoryStorage } = await import('../src/storage.js');
  let text = '第 1 轮回复内容（未完成）';
  let busy = false;
  let nudgeCount = 0;
  const adapter = {
    platform: 'deepseek',
    isBusy: async () => busy,
    lastText: async () => text,
    typeText: async () => { nudgeCount += 1; return true; },
    send: async () => true,
    recentFailureCount: () => 0,
  };
  const engine = new GoEngine(adapter, { status: () => undefined, notify: () => undefined }, new MemoryStorage(), {
    config: { ...createDefaultConfig(), pollMinMs: 5, pollMaxMs: 10, busyStallMs: 40, idleThresholdMs: 30, cooldownMinMs: 15, cooldownMaxMs: 20, maxRounds: 3, injectProtocol: false },
  });
  await engine.start({ maxRounds: 3, injectProtocol: false });
  // 进入生成中（busy 出现）→ 文本停滞超过 busyStallMs
  busy = true;
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(engine.getState().round, 0, 'stall 不得被计为完成一轮');
  // 生成恢复：文本增长 → 完成后到达 idle → 下一轮 nudge 仍可用
  busy = false;
  text = '第 1 轮回复内容（未完成）\n【进度摘要】\n已完成：部分';
  await new Promise((r) => setTimeout(r, 20));
  await engine.stop('测试结束');
});

test('engine stops after consecutive adapter failures', async () => {
  const { GoEngine } = await import('../src/core.js');
  const { createDefaultConfig } = await import('../src/config.js');
  const { MemoryStorage } = await import('../src/storage.js');
  let failures = 0;
  const adapter = {
    platform: 'deepseek',
    isBusy: async () => { failures += 1; return false; },
    lastText: async () => { failures += 1; return ''; },
    typeText: async () => false,
    send: async () => false,
    recentFailureCount: () => failures,
  };
  const engine = new GoEngine(adapter, { status: () => undefined, notify: () => undefined }, new MemoryStorage(), {
    config: { ...createDefaultConfig(), pollMinMs: 5, pollMaxMs: 10, bridgeFailureStopCount: 3, injectProtocol: false },
  });
  await engine.start({ maxRounds: 10, injectProtocol: false });
  const deadline = Date.now() + 1500;
  while (engine.getState().running && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(engine.getState().running, false);
  assert.match(engine.getState().lastStopReason, /桥连接中断/);
  engine.stop('cleanup');
});
