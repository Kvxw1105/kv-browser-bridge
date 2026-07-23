import assert from 'node:assert/strict';
import test from 'node:test';
import { selectUsableBridgeConfig } from '../dist/bridge-client.js';

test('falls back from an incomplete Kv discovery candidate to a usable legacy candidate', () => {
  const legacy = { pipeName: '\\\\.\\pipe\\local-chrome-legacy', token: 'legacy-token' };

  assert.deepEqual(
    selectUsableBridgeConfig([
      { pipeName: '\\\\.\\pipe\\kv-browser-bridge-stale' },
      legacy,
    ]),
    legacy,
  );
});
