import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildIdentityManifests, validateSetup, writeIdentityManifests } from '../scripts/network-identity-setup.mjs';

const base = {
  chromeExecutablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  baseProfileDir: 'D:\\KvBrowserBridge\\profiles',
  identities: [
    { identityId: 'account-a-xhs', accountLabel: 'A', proxyPort: 17891 },
    { identityId: 'account-b-xhs', accountLabel: 'B', proxyPort: 17892 },
  ],
};

test('generates isolated manifests with unique profile and proxy bindings', () => {
  const manifests = buildIdentityManifests(base, new Date('2026-07-29T00:00:00.000Z'));
  assert.equal(manifests.length, 2);
  assert.notEqual(manifests[0].browser.userDataDir, manifests[1].browser.userDataDir);
  assert.notEqual(manifests[0].proxy.port, manifests[1].proxy.port);
  assert.equal(manifests[0].policies.webrtc, 'proxy-only');
  assert.equal(manifests[0].policies.allowConcurrentSessions, false);
});

test('rejects duplicate local proxy endpoints', () => {
  assert.throws(() => validateSetup({
    ...base,
    identities: [
      { identityId: 'account-a-xhs', accountLabel: 'A', proxyPort: 17891 },
      { identityId: 'account-b-xhs', accountLabel: 'B', proxyPort: 17891 },
    ],
  }), /Duplicate proxy endpoint/);
});

test('writes manifests and a one-command acceptance launcher', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-identity-setup-'));
  const result = writeIdentityManifests({ ...base, baseProfileDir: join(root, 'profiles') }, join(root, 'out'), new Date('2026-07-29T00:00:00.000Z'));
  assert.equal(result.manifests.length, 2);
  const manifest = JSON.parse(readFileSync(result.manifests[0], 'utf8'));
  assert.equal(manifest.identityId, 'account-a-xhs');
  const launcher = readFileSync(result.acceptanceScript, 'utf8');
  assert.match(launcher, /accept-network-isolation\.ps1/);
});
