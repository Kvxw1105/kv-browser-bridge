import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromeCandidates, readDevToolsActivePort, runIdentityDoctor } from '../dist/identity/windows-doctor.js';

function manifest(root) {
  return {
    schemaVersion: 1,
    identityId: 'huicelang-douyin',
    workspaceId: 'huicelang',
    platform: 'douyin',
    accountLabel: 'main',
    mode: 'native-stable',
    browser: { executablePath: process.execPath, userDataDir: join(root, 'profile') },
    environment: { osFamily: process.platform === 'win32' ? 'windows' : 'linux', locale: 'zh-CN', timezone: 'Asia/Shanghai', screen: { width: 1920, height: 1080, deviceScaleFactor: 1 } },
    proxy: { id: 'proxy-1', protocol: 'socks5', host: '127.0.0.1', port: 1080, authMode: 'ip-allowlist', countryCode: 'CN', timezone: 'Asia/Shanghai', locale: 'zh-CN' },
    policies: { webrtc: 'proxy-only', dns: 'proxy', ipv6: 'disabled', allowConcurrentSessions: false },
    createdAt: '2026-07-28T00:00:00Z',
    updatedAt: '2026-07-28T00:00:00Z',
  };
}

const stopped = {
  identityId: 'huicelang-douyin',
  state: 'stopped',
  alive: false,
  lockPresent: false,
  receiptPresent: true,
};

test('enumerates standard Chrome installation candidates without duplicates', () => {
  const candidates = chromeCandidates({
    PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\KV\\AppData\\Local',
  });
  assert.equal(candidates.length, 3);
  assert.ok(candidates.every((candidate) => candidate.endsWith(join('Google', 'Chrome', 'Application', 'chrome.exe'))));
});

test('parses a loopback DevToolsActivePort endpoint', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-devtools-'));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'DevToolsActivePort'), '43123\n/devtools/browser/abc\n');
  assert.deepEqual(readDevToolsActivePort(root), {
    port: 43123,
    websocketPath: '/devtools/browser/abc',
    websocketUrl: 'ws://127.0.0.1:43123/devtools/browser/abc',
    sourcePath: join(root, 'DevToolsActivePort'),
  });
});

test('doctor reports stopped identities as not ready without treating absent session files as corruption', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-doctor-'));
  const report = runIdentityDoctor(manifest(root), stopped, { LOCALAPPDATA: join(root, 'appdata') }, () => new Date('2026-07-29T00:00:00Z'));
  assert.equal(report.ready, false);
  assert.equal(report.checks.some((check) => check.code === 'PROFILE_DIRECTORY' && check.status === 'pass'), true);
  assert.equal(report.checks.some((check) => check.code === 'BRIDGE_DISCOVERY' && check.status === 'pass'), true);
  assert.equal(report.checks.some((check) => check.code === 'EXTENSION_HANDSHAKE_REGISTRY' && check.status === 'pass'), true);
});

test('doctor marks a live identity ready only after discovery, handshake registry, and DevTools endpoint exist', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-doctor-ready-'));
  const config = manifest(root);
  mkdirSync(config.browser.userDataDir, { recursive: true });
  writeFileSync(join(config.browser.userDataDir, 'DevToolsActivePort'), '43123\n/devtools/browser/abc\n');
  const appData = join(root, 'appdata');
  const bridgeDir = join(appData, 'KvBrowserBridge', 'identities', config.identityId);
  const sessionsDir = join(appData, 'KvBrowserBridge', 'sessions');
  mkdirSync(bridgeDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(bridgeDir, 'bridge.json'), '{}');
  writeFileSync(join(sessionsDir, `${config.identityId}.json`), '{}');
  const running = { ...stopped, state: 'running', alive: true, lockPresent: true, pid: 42 };
  const report = runIdentityDoctor(config, running, { LOCALAPPDATA: appData });
  assert.equal(report.ready, true);
  assert.equal(report.devTools.port, 43123);
});
