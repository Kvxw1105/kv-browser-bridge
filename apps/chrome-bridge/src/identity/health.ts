import { isIP } from 'node:net';
import type { HealthFinding, HealthReport, IdentityManifest } from './model.js';

const TIMEZONE_COUNTRY_HINTS: Record<string, string[]> = {
  TW: ['Asia/Taipei'],
  CN: ['Asia/Shanghai', 'Asia/Urumqi'],
  HK: ['Asia/Hong_Kong'],
  JP: ['Asia/Tokyo'],
  SG: ['Asia/Singapore'],
  US: ['America/'],
};

export function validateManifest(manifest: IdentityManifest): HealthReport {
  const findings: HealthFinding[] = [];
  if (manifest.schemaVersion !== 1) findings.push(error('SCHEMA_VERSION', 'Unsupported identity schema version.'));
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(manifest.identityId)) findings.push(error('IDENTITY_ID', 'identityId must be a stable lowercase slug.'));
  // The Bridge process re-derives the identity from environment variables and
  // fails hard on invalid slugs (bridge-context IDENTITY_SLUG); validate here
  // so a bad manifest is rejected before a session starts.
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(manifest.workspaceId)) findings.push(error('WORKSPACE_ID', 'workspaceId must be a stable lowercase slug.'));
  if (!manifest.browser.executablePath) findings.push(error('BROWSER_PATH', 'Browser executable path is required.'));
  if (!manifest.browser.userDataDir) findings.push(error('USER_DATA_DIR', 'A dedicated userDataDir is required.'));
  if (manifest.proxy.port < 1 || manifest.proxy.port > 65535) findings.push(error('PROXY_PORT', 'Proxy port is outside the valid range.'));
  if (manifest.environment.locale !== manifest.proxy.locale) findings.push(error('LOCALE_MISMATCH', 'Environment locale must match the bound proxy locale.'));
  if (manifest.environment.timezone !== manifest.proxy.timezone) findings.push(error('TIMEZONE_MISMATCH', 'Environment timezone must match the bound proxy timezone.'));
  const hints = TIMEZONE_COUNTRY_HINTS[manifest.proxy.countryCode.toUpperCase()];
  if (hints && !hints.some((hint) => manifest.proxy.timezone.startsWith(hint))) findings.push(warning('COUNTRY_TIMEZONE_SUSPECT', 'Proxy country and timezone appear inconsistent.'));
  if (manifest.policies.allowConcurrentSessions) findings.push(error('CONCURRENT_SESSION', 'Concurrent sessions are disabled for stable account identities.'));
  if (manifest.policies.webrtc === 'default') findings.push(warning('WEBRTC_DEFAULT', 'Default WebRTC policy may expose a network path outside the proxy.'));
  if (manifest.policies.dns !== 'proxy') findings.push(warning('DNS_SYSTEM', 'System DNS can diverge from the proxy region.'));
  if (manifest.policies.ipv6 === 'disabled') findings.push(info('IPV6_PROBE_REQUIRED', 'IPv6 suppression still requires a real network probe before account use.'));
  if (manifest.environment.screen.width < 800 || manifest.environment.screen.height < 600) findings.push(warning('SCREEN_UNUSUAL', 'Screen dimensions are unusually small for a desktop profile.'));
  if (manifest.mode === 'managed-consistent') findings.push(info('MANAGED_MODE', 'Managed-consistent mode requires an approved browser adapter; no spoofing is performed by this module.'));

  const authMode = manifest.proxy.authMode ?? (manifest.proxy.username ? 'native-adapter' : 'none');
  if (authMode === 'none' && (manifest.proxy.username || manifest.proxy.passwordEnv)) findings.push(error('PROXY_AUTH_MODE', 'Proxy credentials are present while authMode is none.'));
  if (authMode === 'ip-allowlist' && (manifest.proxy.username || manifest.proxy.passwordEnv)) findings.push(error('PROXY_AUTH_MODE', 'IP-allowlist proxy mode must not include credentials.'));
  if (authMode === 'native-adapter' && (!manifest.proxy.username || !manifest.proxy.passwordEnv)) findings.push(error('PROXY_AUTH_CONFIG', 'Native proxy authentication requires username and passwordEnv.'));

  const verification = manifest.networkVerification;
  for (const [name, value] of Object.entries({
    publicIpProbeUrl: verification?.publicIpProbeUrl,
    ipv6ProbeUrl: verification?.ipv6ProbeUrl,
    dnsProbeUrl: verification?.dnsProbeUrl,
  })) {
    if (!value) continue;
    try {
      if (new URL(value).protocol !== 'https:') findings.push(error('NETWORK_PROBE_URL', `${name} must use HTTPS.`));
    } catch {
      findings.push(error('NETWORK_PROBE_URL', `${name} must be a valid URL.`));
    }
  }
  if (verification?.timeoutMs !== undefined && (verification.timeoutMs < 1_000 || verification.timeoutMs > 120_000)) {
    findings.push(error('NETWORK_PROBE_TIMEOUT', 'networkVerification.timeoutMs must be between 1000 and 120000 milliseconds.'));
  }
  if (verification?.expectedDnsResolvers?.some((value) => isIP(value) === 0)) {
    findings.push(error('DNS_RESOLVER_INVALID', 'expectedDnsResolvers must contain only IPv4 or IPv6 addresses.'));
  }
  if (manifest.policies.dns === 'proxy' && !verification?.dnsProbeUrl) findings.push(warning('DNS_PROBE_MISSING', 'Proxy DNS policy is configured but no browser-side dnsProbeUrl is available.'));
  if (manifest.policies.ipv6 === 'disabled' && !verification?.ipv6ProbeUrl) findings.push(warning('IPV6_PROBE_MISSING', 'IPv6 is disabled by policy but no browser-side ipv6ProbeUrl is available.'));

  return { identityId: manifest.identityId, healthy: !findings.some((finding) => finding.severity === 'error'), findings };
}

const error = (code: string, message: string): HealthFinding => ({ severity: 'error', code, message });
const warning = (code: string, message: string): HealthFinding => ({ severity: 'warning', code, message });
const info = (code: string, message: string): HealthFinding => ({ severity: 'info', code, message });
