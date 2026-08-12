import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildNetworkLeakAcceptanceReport, normalizeWebRtcObservations, writeNetworkLeakAcceptanceReport } from '../dist/identity/network-leak-report.js';

const base = {
  identityId: 'huicelang-xhs',
  runtimeSessionId: 'run-1',
  publicIp: '203.0.113.10',
  baselinePublicIp: '203.0.113.10',
  dnsResolvers: ['1.1.1.1'],
  expectedDnsResolvers: ['1.1.1.1'],
  webrtcCandidates: ['203.0.113.10'],
  allowedWebrtcCandidates: ['203.0.113.10'],
  ipv6Addresses: [],
  ipv6Policy: 'disabled',
  generatedAt: '2026-07-29T00:00:00.000Z',
};

test('passes only when public egress DNS WebRTC and IPv6 observations satisfy the contract', () => {
  const report = buildNetworkLeakAcceptanceReport(base);
  assert.equal(report.ready, true);
  assert.deepEqual(report.blockedReasons, []);
  assert.equal(report.publicEgress.status, 'pass');
  assert.equal(report.dns.status, 'pass');
  assert.equal(report.webrtc.status, 'pass');
  assert.equal(report.ipv6.status, 'pass');
});

test('normalizes ICE candidate strings into stable type and address evidence', () => {
  assert.deepEqual(normalizeWebRtcObservations([
    'candidate:1 1 UDP 2122260223 192.168.1.23 54321 typ host generation 0',
    'candidate:2 1 UDP 1686052607 203.0.113.10 60000 typ srflx raddr 0.0.0.0 rport 0',
    'candidate:3 1 UDP 2122260223 abcdef.local 50000 typ host generation 0',
  ]), ['host:192.168.1.23', 'host:mdns', 'srflx:203.0.113.10']);
});

test('fails closed when DNS or WebRTC observations contain unexpected routes', () => {
  const report = buildNetworkLeakAcceptanceReport({
    ...base,
    dnsResolvers: ['8.8.8.8'],
    webrtcCandidates: ['candidate:1 1 UDP 2122260223 192.168.1.23 54321 typ host generation 0'],
  });
  assert.equal(report.ready, false);
  assert.ok(report.blockedReasons.includes('DNS_ROUTE_MISMATCH'));
  assert.ok(report.blockedReasons.includes('WEBRTC_LEAK_DETECTED'));
  assert.deepEqual(report.webrtc.observed, ['host:192.168.1.23']);
});

test('fails closed when disabled IPv6 is observed or evidence is absent', () => {
  const leaked = buildNetworkLeakAcceptanceReport({ ...base, ipv6Addresses: ['2001:db8::1'] });
  assert.ok(leaked.blockedReasons.includes('IPV6_LEAK_DETECTED'));
  const unverified = buildNetworkLeakAcceptanceReport({ ...base, ipv6Addresses: undefined });
  assert.ok(unverified.blockedReasons.includes('IPV6_UNVERIFIED'));
});

test('writes a deterministic private acceptance report for the identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv-leak-report-'));
  const report = buildNetworkLeakAcceptanceReport(base);
  const path = writeNetworkLeakAcceptanceReport(root, report);
  assert.equal(existsSync(path), true);
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.identityId, 'huicelang-xhs');
  assert.equal(saved.ready, true);
});

test('treats mDNS-only WebRTC observations as PASS, not a leak', () => {
  const report = buildNetworkLeakAcceptanceReport({
    ...base,
    webrtcCandidates: [
      'candidate:1 1 UDP 2122260223 abcdef.local 50000 typ host generation 0',
      'candidate:2 1 UDP 2122260223 fedcba.local 50001 typ host generation 0',
    ],
  });
  assert.equal(report.webrtc.status, 'pass');
  assert.deepEqual(report.webrtc.observed, []);
  assert.equal(report.ready, true);
  assert.ok(!report.blockedReasons.includes('WEBRTC_LEAK_DETECTED'));
});

test('still fails closed on a real WebRTC IP outside the allow list', () => {
  const report = buildNetworkLeakAcceptanceReport({
    ...base,
    webrtcCandidates: [
      'candidate:1 1 UDP 2122260223 198.51.100.7 54321 typ srflx generation 0',
      'candidate:2 1 UDP 2122260223 abcdef.local 50000 typ host generation 0',
    ],
  });
  assert.equal(report.webrtc.status, 'fail');
  assert.deepEqual(report.webrtc.observed, ['srflx:198.51.100.7']);
  assert.ok(report.blockedReasons.includes('WEBRTC_LEAK_DETECTED'));
  assert.equal(report.ready, false);
});

test('keeps WebRTC unverified when no candidates were observed', () => {
  const report = buildNetworkLeakAcceptanceReport({ ...base, webrtcCandidates: undefined });
  assert.equal(report.webrtc.status, 'unverified');
  assert.equal(report.ready, false);
  assert.ok(report.blockedReasons.includes('WEBRTC_UNVERIFIED'));
});
