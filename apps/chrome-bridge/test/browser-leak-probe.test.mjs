import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDnsResolvers } from '../dist/identity/browser-leak-probe.js';

test('DNS parser accepts JSON arrays and removes invalid or duplicate entries', () => {
  assert.deepEqual(
    parseDnsResolvers('["1.1.1.1", "8.8.8.8", "1.1.1.1", "not-an-ip"]'),
    ['1.1.1.1', '8.8.8.8'],
  );
});

test('DNS parser accepts object and plain-text probe formats', () => {
  assert.deepEqual(parseDnsResolvers('{"dnsResolvers":["2001:4860:4860::8888","9.9.9.9"]}'), ['2001:4860:4860::8888', '9.9.9.9']);
  assert.deepEqual(parseDnsResolvers('8.8.4.4\n1.0.0.1'), ['1.0.0.1', '8.8.4.4']);
});
