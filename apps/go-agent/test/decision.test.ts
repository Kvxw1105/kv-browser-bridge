import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DECISION_PROVIDER_PRESETS,
  LlmDecisionEngine,
  normalizeLlmOptions,
} from '../src/decision.js';

test('预置厂商：openai 填 key 即可', () => {
  const o = normalizeLlmOptions({ preset: 'openai', apiKey: 'sk-test' });
  assert.ok(o);
  assert.equal(o?.baseUrl, 'https://api.openai.com/v1');
  assert.equal(o?.model, 'gpt-4o-mini');
  assert.equal(o?.apiKey, 'sk-test');
});

test('需要 key 的厂商缺 key 时不可用', () => {
  assert.equal(normalizeLlmOptions({ preset: 'deepseek' }), null);
});

test('ollama 本地模型不需要 key', () => {
  const o = normalizeLlmOptions({ preset: 'ollama' });
  assert.ok(o);
  assert.equal(o?.baseUrl, 'http://localhost:11434/v1');
  assert.equal(o?.apiKey, '');
});

test('custom 保留自定义 baseUrl 入口', () => {
  const o = normalizeLlmOptions({ baseUrl: 'https://my-proxy.example.com/v1', model: 'my-model', apiKey: 'k' });
  assert.ok(o);
  assert.equal(o?.baseUrl, 'https://my-proxy.example.com/v1');
  assert.equal(o?.model, 'my-model');
});

test('未配置的 LLM 引擎回退 null', async () => {
  const engine = new LlmDecisionEngine({ preset: 'openai' });
  assert.equal(engine.configured, false);
  const result = await engine.decide({ goal: 'g', summary: 's', previousQuestion: 'p', round: 1 }, { config: {} as never, state: {} as never });
  assert.equal(result, null);
});

test('预置表包含主流厂商与 ollama', () => {
  for (const name of ['openai', 'deepseek', 'moonshot', 'qwen', 'zhipu', 'siliconflow', 'ollama', 'custom']) {
    assert.ok(DECISION_PROVIDER_PRESETS[name], `missing preset ${name}`);
  }
});
