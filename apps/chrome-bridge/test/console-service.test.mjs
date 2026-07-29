import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { IdentityConsoleService } from '../dist/identity/console-service.js';

function manifest(identityId, port = 7890) { return { schemaVersion: 1, identityId, workspaceId: 'console', platform: 'local', accountLabel: identityId, mode: 'native-stable', browser: { executablePath: process.execPath, userDataDir: join(tmpdir(), identityId) }, environment: { osFamily: 'windows', locale: 'zh-CN', timezone: 'Asia/Shanghai', screen: { width: 1280, height: 720, deviceScaleFactor: 1 } }, proxy: { id: `proxy-${port}`, protocol: 'http', host: '127.0.0.1', port, countryCode: 'CN', locale: 'zh-CN', timezone: 'Asia/Shanghai' }, policies: { webrtc: 'proxy-only', dns: 'proxy', ipv6: 'disabled', allowConcurrentSessions: false }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }; }
test('console persists identities and rejects duplicate profile and proxy bindings', () => { const service = new IdentityConsoleService(mkdtempSync(join(tmpdir(), 'console-'))); service.createIdentity(manifest('account-a')); assert.equal(service.listIdentities()[0].status, 'not-started'); assert.throws(() => service.createIdentity({ ...manifest('account-b', 7891), browser: { executablePath: process.execPath, userDataDir: join(tmpdir(), 'account-a') } }), /PROFILE_PATH_DUPLICATE/); assert.throws(() => service.createIdentity({ ...manifest('account-b', 7890), browser: { executablePath: process.execPath, userDataDir: join(tmpdir(), 'other-profile') } }), /PROXY_ENDPOINT_DUPLICATE/); });
