import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePublicIp, probeBrowserPublicIp } from '../dist/identity/browser-network-probe.js';

test('parses JSON and plain-text public IP responses', () => {
  assert.equal(parsePublicIp('{"ip":"1.1.1.1"}'), '1.1.1.1');
  assert.equal(parsePublicIp('2001:4860:4860::8888'), '2001:4860:4860::8888');
  assert.throws(() => parsePublicIp('not-an-ip'));
});

test('fails closed when DevTools websocket is absent', async () => {
  const result = await probeBrowserPublicIp({ port: 1234, sourcePath: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'DEVTOOLS_WEBSOCKET_MISSING');
});

test('rejects non-HTTPS probe URLs before opening a websocket', async () => {
  const result = await probeBrowserPublicIp(
    { port: 1234, websocketUrl: 'ws://127.0.0.1:1234/devtools/browser/a', sourcePath: 'x' },
    { probeUrl: 'http://example.com', webSocketFactory: () => { throw new Error('should not run'); } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PROBE_URL_INSECURE');
});
