import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  listIdentitySessions,
  parsePublicIdentitySession,
  privateDiscoveryPath,
  resolveIdentityDiscovery,
} from '../dist/identity-registry.js';

async function fixture() {
  const localAppData = await mkdtemp(join(tmpdir(), 'kv-identity-registry-'));
  const env = { LOCALAPPDATA: localAppData };
  const root = join(localAppData, 'KvBrowserBridge');
  await mkdir(join(root, 'sessions'), { recursive: true });
  await mkdir(join(root, 'identities', 'huicelang-douyin'), { recursive: true });
  await writeFile(join(root, 'sessions', 'huicelang-douyin.json'), JSON.stringify({
    schemaVersion: 1,
    identity: { identityId: 'huicelang-douyin', workspaceId: 'huicelang', platform: 'douyin' },
    pid: process.pid,
    startedAt: '2026-07-29T00:00:00.000Z',
    protocolVersion: 1,
  }));
  await writeFile(join(root, 'identities', 'huicelang-douyin', 'bridge.json'), JSON.stringify({ token: 'private' }));
  return { env, root };
}

async function dualFixture() {
  const localAppData = await mkdtemp(join(tmpdir(), 'kv-identity-registry-dual-'));
  const env = { LOCALAPPDATA: localAppData };
  const root = join(localAppData, 'KvBrowserBridge');
  await mkdir(join(root, 'sessions'), { recursive: true });
  for (const [identityId, pid] of [['identity-a', process.pid], ['identity-b', process.pid + 1]]) {
    await mkdir(join(root, 'identities', identityId), { recursive: true });
    await writeFile(join(root, 'sessions', `${identityId}.json`), JSON.stringify({ schemaVersion: 1, identity: { identityId, workspaceId: 'alpha', platform: 'windows', runtimeSessionId: `run-${identityId}` }, pid, startedAt: '2026-07-29T00:00:00.000Z', protocolVersion: 1 }));
    await writeFile(join(root, 'identities', identityId, 'bridge.json'), JSON.stringify({ token: `private-${identityId}` }));
  }
  return { env };
}

test('lists two selectable sessions without crossing identity metadata', async () => {
  const { env } = await dualFixture();
  const sessions = await listIdentitySessions(env);
  assert.deepEqual(sessions.map((session) => session.identity.identityId), ['identity-a', 'identity-b']);
  assert.deepEqual(sessions.map((session) => session.identity.runtimeSessionId), ['run-identity-a', 'run-identity-b']);
  assert.equal(JSON.stringify(sessions).includes('private-'), false);
});

test('lists public identity sessions without reading private bridge credentials', async () => {
  const { env } = await fixture();
  const sessions = await listIdentitySessions(env);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].identity.identityId, 'huicelang-douyin');
  assert.equal(sessions[0].processAlive, true);
  assert.equal(sessions[0].discoveryPresent, true);
  assert.equal(JSON.stringify(sessions).includes('private'), false);
});

test('resolves an exact running identity to its private discovery file', async () => {
  const { env } = await fixture();
  assert.equal(
    await resolveIdentityDiscovery('huicelang-douyin', env),
    privateDiscoveryPath('huicelang-douyin', env),
  );
  await assert.rejects(() => resolveIdentityDiscovery('xuanqi-xhs', env), /not registered/);
});

test('ignores corrupt public records instead of hiding healthy sessions', async () => {
  const { env, root } = await fixture();
  await writeFile(join(root, 'sessions', 'broken.json'), '{');
  assert.equal((await listIdentitySessions(env)).length, 1);
});

test('rejects path traversal and malformed public records', () => {
  assert.throws(() => privateDiscoveryPath('../escape'), /stable lowercase slug/);
  assert.throws(() => parsePublicIdentitySession({ schemaVersion: 1, identity: { identityId: 'ok-id' }, pid: 0 }), /PID/);
});
