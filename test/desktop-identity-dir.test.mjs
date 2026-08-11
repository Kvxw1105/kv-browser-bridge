import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { migrateLegacyConsoleDir, resolveIdentityConsoleDir } from '../scripts/identity-console-dir.mjs';

test('resolveIdentityConsoleDir defaults to the unified KvBrowserBridge identity-console directory', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
  const dir = resolveIdentityConsoleDir(env, 'C:\\work');
  assert.equal(dir, 'C:\\Users\\u\\AppData\\Local\\KvBrowserBridge\\identity-console');
});

test('resolveIdentityConsoleDir honors the KV_BROWSER_IDENTITY_HOME override', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', KV_BROWSER_IDENTITY_HOME: 'D:\\kv-home' };
  assert.equal(resolveIdentityConsoleDir(env, 'C:\\work'), 'D:\\kv-home');
});

test('resolveIdentityConsoleDir falls back to USERPROFILE\\AppData\\Local without LOCALAPPDATA', () => {
  const env = { USERPROFILE: 'C:\\Users\\u' };
  assert.equal(resolveIdentityConsoleDir(env, 'C:\\work'), 'C:\\Users\\u\\AppData\\Local\\KvBrowserBridge\\identity-console');
});

test('migrateLegacyConsoleDir copies legacy manifests once and only when target is empty', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-identity-dir-'));
  const legacy = join(root, 'legacy-user-data');
  const target = join(root, 'target');
  mkdirSync(join(legacy, 'identity-console'), { recursive: true });
  writeFileSync(join(legacy, 'identity-console', 'identity-console.manifests.json'), '[{"identityId":"a"}]');
  try {
    assert.equal(migrateLegacyConsoleDir(target, legacy), true);
    assert.equal(migrateLegacyConsoleDir(target, legacy), false, 'second call is a no-op');
    const copied = join(target, 'identity-console.manifests.json');
    assert.equal(existsSync(copied), true);
    // Target already has data: legacy must not overwrite.
    writeFileSync(copied, '[{"identityId":"new"}]');
    assert.equal(migrateLegacyConsoleDir(target, legacy), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
