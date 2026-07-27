import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KV_NATIVE_HOST_NAME,
  LEGACY_NATIVE_HOST_NAME,
  createNativeHostManifest,
  isKvOwnedManifest,
  isKvOwnedWrapper,
  parseInstallerArgs,
} from '../dist/install-helpers.js';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

test('builds a Kv-only native host manifest', () => {
  const manifest = createNativeHostManifest(EXTENSION_ID, 'C:\\bridge\\io.kv.browser_bridge.cmd');

  assert.deepEqual(manifest, {
    name: 'io.kv.browser_bridge',
    description: 'Kv Browser Bridge',
    path: 'C:\\bridge\\io.kv.browser_bridge.cmd',
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  });
});

test('requires an explicit, valid extension ID for installation', () => {
  assert.deepEqual(parseInstallerArgs(['install', EXTENSION_ID]), { command: 'install', extensionId: EXTENSION_ID });
  assert.deepEqual(parseInstallerArgs(['test-install', EXTENSION_ID]), { command: 'test-install', extensionId: EXTENSION_ID });
  assert.deepEqual(parseInstallerArgs(['test-restore']), { command: 'test-restore' });
  assert.throws(() => parseInstallerArgs([]), /extension ID is required/);
  assert.throws(() => parseInstallerArgs(['install', 'ABC']), /32 lowercase letters/);
  assert.throws(() => parseInstallerArgs(['install', 'qbcdefghijklmnopabcdefghijklmnop']), /a to p/);
  assert.throws(() => parseInstallerArgs(['uninstall', EXTENSION_ID]), /Usage/);
  assert.deepEqual(parseInstallerArgs(['uninstall']), { command: 'uninstall' });
  assert.deepEqual(parseInstallerArgs(['doctor', '--json']), { command: 'doctor', json: true });
  assert.throws(() => parseInstallerArgs(['doctor', 'oops']), /Usage/);
});

test('Kv and legacy native host names differ', () => {
  assert.equal(KV_NATIVE_HOST_NAME, 'io.kv.browser_bridge');
  assert.equal(LEGACY_NATIVE_HOST_NAME, 'com.claude_code_browser');
  assert.notEqual(KV_NATIVE_HOST_NAME, LEGACY_NATIVE_HOST_NAME);
});

test('recognizes only Kv-owned manifest and wrapper content', () => {
  const wrapper = 'REM Kv Browser Bridge wrapper - managed by Kv\r\n';
  const manifest = createNativeHostManifest(EXTENSION_ID, 'C:\\bridge\\io.kv.browser_bridge.cmd');
  assert.equal(isKvOwnedWrapper(wrapper), true);
  assert.equal(isKvOwnedWrapper('@echo off'), false);
  assert.equal(isKvOwnedManifest(manifest, 'C:\\bridge\\io.kv.browser_bridge.cmd'), true);
  assert.equal(isKvOwnedManifest({ ...manifest, description: 'other' }), false);
});
