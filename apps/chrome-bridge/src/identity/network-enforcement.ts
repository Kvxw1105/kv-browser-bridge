import type { NetworkLeakAcceptanceReport } from './network-leak-report.js';

export type NetworkEnforcementMode = 'observe' | 'strict';
export type NetworkEnforcementAction = 'allow' | 'warn' | 'freeze' | 'stop';

export interface NetworkEnforcementPolicy {
  mode: NetworkEnforcementMode;
  uniqueProxyEndpoint: boolean;
  uniquePublicEgress: boolean;
}

export const DEFAULT_NETWORK_ENFORCEMENT_POLICY: NetworkEnforcementPolicy = {
  mode: 'observe',
  uniqueProxyEndpoint: false,
  uniquePublicEgress: false,
};

export interface NetworkEnforcementDecision {
  action: NetworkEnforcementAction;
  reasons: string[];
  warnings: string[];
}

export function enforceNetworkAssessment(
  report: Pick<NetworkLeakAcceptanceReport, 'publicEgress' | 'dns' | 'webrtc' | 'ipv6'>,
  policy: NetworkEnforcementPolicy = DEFAULT_NETWORK_ENFORCEMENT_POLICY,
): NetworkEnforcementDecision {
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (report.publicEgress.status === 'fail') reasons.push('PUBLIC_EGRESS_MISMATCH');
  if (report.ipv6.status === 'fail') reasons.push('IPV6_LEAK_DETECTED');
  if (report.webrtc.status === 'fail' && hasRealWebRtcLeak(report.webrtc.observed)) reasons.push('WEBRTC_LEAK_DETECTED');
  if (report.dns.status === 'unverified') warnings.push('DNS_UNVERIFIED');
  if (report.webrtc.status === 'unverified') warnings.push('WEBRTC_UNVERIFIED');
  if (report.publicEgress.status === 'fail' && !policy.uniquePublicEgress) warnings.push('PUBLIC_EGRESS_MISMATCH');
  if (policy.mode === 'observe') {
    if (reasons.length > 0) warnings.push(...reasons);
    return { action: warnings.length > 0 ? 'warn' : 'allow', reasons: [], warnings: unique(warnings) };
  }
  if (reasons.includes('PUBLIC_EGRESS_MISMATCH') || reasons.includes('IPV6_LEAK_DETECTED')) {
    return { action: 'stop', reasons: unique(reasons), warnings: unique(warnings) };
  }
  if (reasons.includes('WEBRTC_LEAK_DETECTED')) return { action: 'freeze', reasons: unique(reasons), warnings: unique(warnings) };
  return { action: warnings.length > 0 ? 'warn' : 'allow', reasons: [], warnings: unique(warnings) };
}

function hasRealWebRtcLeak(values: string[] | undefined): boolean {
  return (values ?? []).some((value) => {
    const normalized = value.trim().toLowerCase();
    return normalized !== 'mdns' && !normalized.endsWith(':mdns');
  });
}

function unique(values: string[]): string[] { return [...new Set(values)]; }
