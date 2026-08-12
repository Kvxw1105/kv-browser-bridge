import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { ChromeCdpTransport } from '../dist/identity/chrome-cdp-transport.js';

function pipes() {
  return { write: new PassThrough(), read: new PassThrough() };
}

test('encodes null-delimited CDP requests and resolves matching responses', async () => {
  const { write, read } = pipes();
  const transport = new ChromeCdpTransport(write, read);
  const request = transport.request('Browser.getVersion', { probe: true });
  const encoded = await new Promise((resolve) => write.once('data', (chunk) => resolve(String(chunk))));
  const message = JSON.parse(encoded.replace(/\0$/, ''));
  assert.equal(message.id, 1);
  assert.equal(message.method, 'Browser.getVersion');
  assert.deepEqual(message.params, { probe: true });
  read.write(`${JSON.stringify({ id: message.id, result: { product: 'Chrome/150' } })}\0`);
  assert.deepEqual(await request, { product: 'Chrome/150' });
  await transport.close();
});

test('rejects a request after its timeout', async () => {
  const { write, read } = pipes();
  const transport = new ChromeCdpTransport(write, read);
  await assert.rejects(transport.request('Target.getTargets', {}, 20), /timed out/);
  await transport.close();
});

test('rejects pending requests when the Chrome read pipe closes', async () => {
  const { write, read } = pipes();
  const transport = new ChromeCdpTransport(write, read);
  const pending = transport.request('Target.getTargets', {}, 5_000);
  read.destroy();
  await assert.rejects(pending, /pipe closed/);
  await transport.close();
});

test('controlled close rejects pending requests and is idempotent', async () => {
  const { write, read } = pipes();
  const transport = new ChromeCdpTransport(write, read);
  const pending = transport.request('Extensions.getExtensions', {}, 5_000);
  await transport.close();
  await transport.close();
  await assert.rejects(pending, /pipe closed/);
});
