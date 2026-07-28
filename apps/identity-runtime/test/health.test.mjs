import assert from 'node:assert/strict';
import test from 'node:test';
import { validateManifest } from '../dist/health.js';

const base = {
  schemaVersion: 1,
  identityId: 'huicelang-douyin',
  workspaceId: 'huicelang',
  platform: 'douyin',
  accountLabel: 'main',
  mode: 'native-stable',
  browser: { executablePath: '/bin/echo', userDataDir: '/tmp/huicelang' },
  environment: { osFamily: 'linux', locale: 'zh-CN', timezone: 'Asia/Shanghai', screen: { width: 1920, height: 1080, deviceScaleFactor: 1 } },
  proxy: { id: 'proxy-1', protocol: 'socks5', host: '127.0.0.1', port: 1080, countryCode: 'CN', timezone: 'Asia/Shanghai', locale: 'zh-CN' },
  policies: { webrtc: 'proxy-only', dns: 'proxy', ipv6: 'disabled', allowConcurrentSessions: false },
  createdAt: '2026-07-28T00:00:00Z',
  updatedAt: '2026-07-28T00:00:00Z'
};

test('accepts a stable, internally consistent identity', () => {
  assert.equal(validateManifest(base).healthy, true);
});

test('blocks locale and concurrency conflicts', () => {
  const report = validateManifest({
    ...base,
    environment: { ...base.environment, locale: 'en-US' },
    policies: { ...base.policies, allowConcurrentSessions: true }
  });
  assert.equal(report.healthy, false);
  assert.deepEqual(
    report.findings.filter((finding) => finding.severity === 'error').map((finding) => finding.code).sort(),
    ['CONCURRENT_SESSION', 'LOCALE_MISMATCH']
  );
});
