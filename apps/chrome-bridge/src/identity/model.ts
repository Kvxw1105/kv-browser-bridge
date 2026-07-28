export type IdentityMode = 'native-stable' | 'managed-consistent';
export type ProxyProtocol = 'http' | 'https' | 'socks5';
export type ProxyAuthMode = 'none' | 'ip-allowlist' | 'native-adapter';
export type RuntimeSessionState = 'starting' | 'running' | 'stopped' | 'failed' | 'crashed';

export interface ProxyBinding {
  id: string;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string;
  passwordEnv?: string;
  authMode?: ProxyAuthMode;
  countryCode: string;
  timezone: string;
  locale: string;
}

export interface NetworkVerificationConfig {
  publicIpProbeUrl?: string;
  ipv6ProbeUrl?: string;
  dnsProbeUrl?: string;
  expectedDnsResolvers?: string[];
  allowedWebrtcCandidates?: string[];
  timeoutMs?: number;
}

export interface IdentityManifest {
  schemaVersion: 1;
  identityId: string;
  workspaceId: string;
  platform: string;
  accountLabel: string;
  mode: IdentityMode;
  browser: {
    executablePath: string;
    userDataDir: string;
    profileDirectory?: string;
    majorVersion?: number;
  };
  environment: {
    osFamily: 'windows' | 'linux' | 'macos';
    locale: string;
    timezone: string;
    screen: { width: number; height: number; deviceScaleFactor: number };
  };
  proxy: ProxyBinding;
  policies: {
    webrtc: 'default' | 'proxy-only' | 'disabled';
    dns: 'system' | 'proxy';
    ipv6: 'default' | 'disabled';
    allowConcurrentSessions: boolean;
  };
  networkVerification?: NetworkVerificationConfig;
  createdAt: string;
  updatedAt: string;
}

export interface HealthFinding {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
}

export interface HealthReport {
  identityId: string;
  healthy: boolean;
  findings: HealthFinding[];
}

export interface RuntimeLockRecord {
  schemaVersion: 1;
  identityId: string;
  lockId: string;
  pid: number;
  phase: 'starting' | 'running';
  acquiredAt: string;
  updatedAt: string;
  userDataDir: string;
}

export interface RuntimeReceipt {
  schemaVersion: 1;
  identityId: string;
  runtimeSessionId?: string;
  state: RuntimeSessionState;
  pid?: number;
  lockId?: string;
  executablePath?: string;
  args?: string[];
  startedAt?: string;
  stoppedAt?: string;
  updatedAt: string;
  failure?: { code: string; message: string };
}

export interface RuntimeStatus {
  identityId: string;
  state: RuntimeSessionState | 'not-started' | 'orphaned-running' | 'stale-lock' | 'corrupt-lock';
  pid?: number;
  alive: boolean;
  lockPresent: boolean;
  receiptPresent: boolean;
  message?: string;
}
