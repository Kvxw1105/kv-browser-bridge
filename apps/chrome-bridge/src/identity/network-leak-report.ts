import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';

export type LeakCheckStatus = 'pass' | 'fail' | 'unverified' | 'not-applicable';

export interface NetworkLeakCheck {
  status: LeakCheckStatus;
  observed?: string[];
  expected?: string[];
  details?: string;
}

export interface NetworkLeakAcceptanceReport {
  schemaVersion: 1;
  identityId: string;
  runtimeSessionId: string;
  generatedAt: string;
  publicEgress: NetworkLeakCheck;
  dns: NetworkLeakCheck;
  webrtc: NetworkLeakCheck;
  ipv6: NetworkLeakCheck;
  ready: boolean;
  blockedReasons: string[];
}

export interface BuildLeakReportInput {
  identityId: string;
  runtimeSessionId: string;
  publicIp?: string;
  baselinePublicIp?: string;
  dnsResolvers?: string[];
  expectedDnsResolvers?: string[];
  webrtcCandidates?: string[];
  allowedWebrtcCandidates?: string[];
  ipv6Addresses?: string[];
  ipv6Policy: 'default' | 'disabled';
  generatedAt?: string;
}

export function buildNetworkLeakAcceptanceReport(input: BuildLeakReportInput): NetworkLeakAcceptanceReport {
  const blockedReasons: string[] = [];
  const publicEgress = compareSingleIp(input.publicIp, input.baselinePublicIp, 'PUBLIC_EGRESS_UNVERIFIED', 'PUBLIC_EGRESS_MISMATCH', blockedReasons);
  const dns = compareSets(input.dnsResolvers, input.expectedDnsResolvers, 'DNS_UNVERIFIED', 'DNS_ROUTE_MISMATCH', blockedReasons);
  const webrtc = compareSets(
    normalizeWebRtcObservations(input.webrtcCandidates),
    normalizeWebRtcObservations(input.allowedWebrtcCandidates),
    'WEBRTC_UNVERIFIED',
    'WEBRTC_LEAK_DETECTED',
    blockedReasons,
  );

  let ipv6: NetworkLeakCheck;
  const observedIpv6 = (input.ipv6Addresses ?? []).filter((value) => isIP(value) === 6);
  if (input.ipv6Policy === 'disabled') {
    if (input.ipv6Addresses === undefined) {
      blockedReasons.push('IPV6_UNVERIFIED');
      ipv6 = { status: 'unverified', details: 'IPv6 policy is disabled but no browser-side IPv6 observation was supplied.' };
    } else if (observedIpv6.length > 0) {
      blockedReasons.push('IPV6_LEAK_DETECTED');
      ipv6 = { status: 'fail', observed: observedIpv6, expected: [], details: 'IPv6 was observed while the identity policy requires it disabled.' };
    } else {
      ipv6 = { status: 'pass', observed: [], expected: [] };
    }
  } else {
    ipv6 = input.ipv6Addresses === undefined
      ? { status: 'unverified', details: 'IPv6 observation has not been supplied.' }
      : { status: 'pass', observed: observedIpv6 };
  }

  return {
    schemaVersion: 1,
    identityId: input.identityId,
    runtimeSessionId: input.runtimeSessionId,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    publicEgress,
    dns,
    webrtc,
    ipv6,
    ready: blockedReasons.length === 0,
    blockedReasons: [...new Set(blockedReasons)],
  };
}

export function writeNetworkLeakAcceptanceReport(rootDir: string, report: NetworkLeakAcceptanceReport): string {
  const directory = join(rootDir, report.identityId, 'network');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'network-leak-acceptance.json');
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
  return path;
}

export function normalizeWebRtcObservations(values: string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  const normalized: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    if (isIP(value)) {
      normalized.push(value);
      continue;
    }
    const candidateParts = value.split(/\s+/);
    const address = candidateParts.length >= 5 ? candidateParts[4] : undefined;
    const typeIndex = candidateParts.findIndex((part) => part === 'typ');
    const candidateType = typeIndex >= 0 ? candidateParts[typeIndex + 1] : undefined;
    if (address && isIP(address)) normalized.push(candidateType ? `${candidateType}:${address}` : address);
    else if (/\.local$/i.test(address ?? '')) normalized.push(candidateType ? `${candidateType}:mdns` : 'mdns');
  }
  return [...new Set(normalized)].sort();
}

function compareSingleIp(
  observed: string | undefined,
  expected: string | undefined,
  unverifiedCode: string,
  mismatchCode: string,
  blockedReasons: string[],
): NetworkLeakCheck {
  if (!observed || !expected || !isIP(observed) || !isIP(expected)) {
    blockedReasons.push(unverifiedCode);
    return { status: 'unverified', observed: observed ? [observed] : undefined, expected: expected ? [expected] : undefined };
  }
  if (observed !== expected) {
    blockedReasons.push(mismatchCode);
    return { status: 'fail', observed: [observed], expected: [expected] };
  }
  return { status: 'pass', observed: [observed], expected: [expected] };
}

function compareSets(
  observed: string[] | undefined,
  expected: string[] | undefined,
  unverifiedCode: string,
  mismatchCode: string,
  blockedReasons: string[],
): NetworkLeakCheck {
  if (observed === undefined || expected === undefined) {
    blockedReasons.push(unverifiedCode);
    return { status: 'unverified', observed, expected };
  }
  const normalizedObserved = [...new Set(observed.map((value) => value.trim()).filter(Boolean))].sort();
  const normalizedExpected = [...new Set(expected.map((value) => value.trim()).filter(Boolean))].sort();
  const unexpected = normalizedObserved.filter((value) => !normalizedExpected.includes(value));
  if (unexpected.length > 0) {
    blockedReasons.push(mismatchCode);
    return { status: 'fail', observed: normalizedObserved, expected: normalizedExpected, details: `Unexpected observations: ${unexpected.join(', ')}` };
  }
  return { status: 'pass', observed: normalizedObserved, expected: normalizedExpected };
}
