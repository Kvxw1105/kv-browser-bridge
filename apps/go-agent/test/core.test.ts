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
