import assert from 'node:assert/strict';
import test from 'node:test';
import { chromeExtensionIdFromManifest } from '../scripts/chrome-extension-id.mjs';

test('derives the stable Native Messaging extension ID from the manifest key', () => {
  assert.equal(chromeExtensionIdFromManifest('apps/extension'), 'kfaihbpaejdkonnjdinaiofahiaedokh');
});
