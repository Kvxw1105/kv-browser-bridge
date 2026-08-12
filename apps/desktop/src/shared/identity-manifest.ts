export type ProxyProtocol = 'http' | 'https' | 'socks5';

export interface IdentityManifest {
  schemaVersion: 1;
  identityId: string;
  workspaceId: string;
  platform: string;
  accountLabel: string;
  mode: 'native-stable' | 'managed-consistent';
  browser: { executablePath: string; userDataDir: string; profileDirectory?: string };
  environment: { osFamily: 'windows' | 'linux' | 'macos'; locale: string; timezone: string; screen: { width: number; height: number; deviceScaleFactor: number } };
  proxy: { id: string; protocol: ProxyProtocol; host: string; port: number; username?: string; passwordEnv?: string; authMode?: 'none' | 'ip-allowlist' | 'native-adapter'; countryCode: string; timezone: string; locale: string };
  policies: { webrtc: 'default' | 'proxy-only' | 'disabled'; dns: 'system' | 'proxy'; ipv6: 'default' | 'disabled'; allowConcurrentSessions: boolean };
  createdAt: string;
  updatedAt: string;
}
