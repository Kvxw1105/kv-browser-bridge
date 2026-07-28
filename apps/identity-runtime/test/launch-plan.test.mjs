import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLaunchPlan } from '../dist/launch-plan.js';

const manifest = {
  schemaVersion: 1,
  identityId: 'xuanqi-xhs',
  workspaceId: 'xuanqi',
  platform: 'xiaohongshu',
  accountLabel: 'main',
  mode: 'native-stable',
  browser: { executablePath: '/bin/echo', userDataDir: '/tmp/xuanqi', profileDirectory: 'Default' },
  environment: { osFamily: 'linux', locale: 'zh-CN', timezone: 'Asia/Shanghai', screen: { width: 1920, height: 1080, deviceScaleFactor: 1 } },
  proxy: { id: 'proxy-2', protocol: 'socks5', host: '127.0.0.1', port: 1080, username: 'u', passwordEnv: 'KV_PROXY_SECRET', countryCode: 'CN', timezone: 'Asia/Shanghai', locale: 'zh-CN' },
  policies: { webrtc: 'proxy-only', dns: 'proxy', ipv6: 'disabled', allowConcurrentSessions: false },
  createdAt: '2026-07-28T00:00:00Z',
  updatedAt: '2026-07-28T00:00:00Z'
};

test('blocks launch when the proxy secret is missing', () => {
  const plan = buildLaunchPlan(manifest, {});
  assert.ok(plan.blockedReasons.some((reason) => reason.startsWith('PROXY_SECRET_MISSING')));
  assert.ok(!JSON.stringify(plan).includes('undefined@'));
});

test('builds a persistent profile plan when credentials are available', () => {
  const plan = buildLaunchPlan(manifest, { KV_PROXY_SECRET: 'p@ss' });
  assert.equal(plan.blockedReasons.length, 0);
  assert.ok(plan.args.includes('--user-data-dir=/tmp/xuanqi'));
  assert.ok(plan.args.some((argument) => argument.includes('p%40ss')));
});
