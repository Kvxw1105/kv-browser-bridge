export type IdentityMode = 'native-stable' | 'managed-consistent';
export type ProxyProtocol = 'http' | 'https' | 'socks5';

export interface ProxyBinding {
  id: string;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string;
  passwordEnv?: string;
  countryCode: string;
  timezone: string;
  locale: string;
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
