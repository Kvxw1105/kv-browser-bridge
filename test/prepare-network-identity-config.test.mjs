import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareSetupConfig, uniqueProxyCandidates } from '../scripts/prepare-network-identity-config.mjs';

const discovery = {
  schemaVersion: 1,
  platform: 'windows',
  recommendedChromePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  chromeCandidates: [],
  proxyCandidates: [
    { host: '127.0.0.1', port: 17892, kind: 'likely-proxy-inbound' },
    { host: '0.0.0.0', port: 17891, kind: 'likely-proxy-inbound' },
    { host: '127.0.0.1', port: 17891, kind: 'duplicate' },
  ],
};

test('prepares editable setup using discovered Chrome and unique proxy ports', () => {
  const config = prepareSetupConfig(discovery, { accountCount: 2 });
  assert.equal(config.chromeExecutablePath, discovery.recommendedChromePath);
  assert.equal(config.identities.length, 2);
  assert.deepEqual(config.identities.map((identity) => identity.proxyPort), [17891, 17892]);
  assert.notEqual(config.identities[0].identityId, config.identities[1].identityId);
});

test('fills deterministic local port placeholders when discovery has too few candidates', () => {
  const config = prepareSetupConfig({ ...discovery, proxyCandidates: [] }, { accountCount: 3 });
  assert.deepEqual(config.identities.map((identity) => identity.proxyPort), [17891, 17892, 17893]);
});

test('normalizes and deduplicates proxy candidates', () => {
  const candidates = uniqueProxyCandidates(discovery.proxyCandidates);
  assert.deepEqual(candidates.map((candidate) => `${candidate.host}:${candidate.port}`), [
    '127.0.0.1:17891',
    '127.0.0.1:17892',
  ]);
});

test('rejects an invalid discovery report', () => {
  assert.throws(() => prepareSetupConfig({ schemaVersion: 2, platform: 'windows' }), /schemaVersion 1/);
});
