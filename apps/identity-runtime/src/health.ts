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
  if (!manifest.browser.executablePath) findings.push(error('BROWSER_PATH', 'Browser executable path is required.'));
  if (!manifest.browser.userDataDir) findings.push(error('USER_DATA_DIR', 'A dedicated userDataDir is required.'));
  if (manifest.proxy.port < 1 || manifest.proxy.port > 65535) findings.push(error('PROXY_PORT', 'Proxy port is outside the valid range.'));
  if (manifest.environment.locale !== manifest.proxy.locale) findings.push(error('LOCALE_MISMATCH', 'Environment locale must match the bound proxy locale.'));
  if (manifest.environment.timezone !== manifest.proxy.timezone) findings.push(error('TIMEZONE_MISMATCH', 'Environment timezone must match the bound proxy timezone.'));
  const hints = TIMEZONE_COUNTRY_HINTS[manifest.proxy.countryCode.toUpperCase()];
  if (hints && !hints.some((hint) => manifest.proxy.timezone.startsWith(hint))) {
    findings.push(warning('COUNTRY_TIMEZONE_SUSPECT', 'Proxy country and timezone appear inconsistent.'));
  }
  if (manifest.policies.allowConcurrentSessions) findings.push(error('CONCURRENT_SESSION', 'Concurrent sessions are disabled for stable account identities.'));
  if (manifest.policies.webrtc === 'default') findings.push(warning('WEBRTC_DEFAULT', 'Default WebRTC policy may expose a network path outside the proxy.'));
  if (manifest.policies.dns !== 'proxy') findings.push(warning('DNS_SYSTEM', 'System DNS can diverge from the proxy region.'));
  if (manifest.environment.screen.width < 800 || manifest.environment.screen.height < 600) findings.push(warning('SCREEN_UNUSUAL', 'Screen dimensions are unusually small for a desktop profile.'));
  if (manifest.mode === 'managed-consistent') findings.push(info('MANAGED_MODE', 'Managed-consistent mode requires an approved browser adapter; no spoofing is performed by this package.'));
  return { identityId: manifest.identityId, healthy: !findings.some((finding) => finding.severity === 'error'), findings };
}

const error = (code: string, message: string): HealthFinding => ({ severity: 'error', code, message });
const warning = (code: string, message: string): HealthFinding => ({ severity: 'warning', code, message });
const info = (code: string, message: string): HealthFinding => ({ severity: 'info', code, message });
