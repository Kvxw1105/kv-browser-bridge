import assert from 'node:assert/strict';
import test from 'node:test';
import { enforceNetworkAssessment } from '../dist/identity/network-enforcement.js';

const base = {
  publicEgress: { status: 'pass' },
  dns: { status: 'pass' },
  webrtc: { status: 'pass', observed: [] },
  ipv6: { status: 'pass' },
};

test('observe mode warns without stopping on duplicate public egress', () => {
  const result = enforceNetworkAssessment({ ...base, publicEgress: { status: 'fail' } });
  assert.equal(result.action, 'warn');
  assert.deepEqual(result.reasons, []);
  assert.ok(result.warnings.includes('PUBLIC_EGRESS_MISMATCH'));
});

test('mDNS-only WebRTC observations do not become a hard leak', () => {
  const result = enforceNetworkAssessment({ ...base, webrtc: { status: 'fail', observed: ['host:mdns', 'mdns'] } }, { mode: 'strict', uniqueProxyEndpoint: false, uniquePublicEgress: false });
  assert.equal(result.action, 'allow');
  assert.deepEqual(result.reasons, []);
});

test('strict mode stops on public egress mismatch and real IPv6', () => {
  const result = enforceNetworkAssessment({ ...base, publicEgress: { status: 'fail' }, ipv6: { status: 'fail', observed: ['2001:db8::1'] } }, { mode: 'strict', uniqueProxyEndpoint: false, uniquePublicEgress: true });
  assert.equal(result.action, 'stop');
  assert.deepEqual(result.reasons, ['PUBLIC_EGRESS_MISMATCH', 'IPV6_LEAK_DETECTED']);
});

test('missing DNS evidence remains a warning in strict mode', () => {
  const result = enforceNetworkAssessment({ ...base, dns: { status: 'unverified' } }, { mode: 'strict', uniqueProxyEndpoint: false, uniquePublicEgress: false });
  assert.equal(result.action, 'warn');
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.warnings, ['DNS_UNVERIFIED']);
});
