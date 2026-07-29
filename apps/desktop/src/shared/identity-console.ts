export type IdentityConsoleStatus = 'not-started' | 'starting' | 'running' | 'stopped' | 'failed' | 'frozen' | 'unverified' | 'warning';

export interface IdentityConsoleError {
  code: string;
  message: string;
}

export interface IdentityConsoleManifest {
  identityId: string;
  accountLabel: string;
  browser: {
    executablePath: string;
    userDataDir: string;
  };
  environment: {
    locale: string;
    timezone: string;
  };
  proxy: {
    protocol: 'http' | 'https' | 'socks5';
    host: string;
    port: number;
  };
}

export interface IdentityConsoleItem {
  manifest: IdentityConsoleManifest;
  status: IdentityConsoleStatus;
  runtime: {
    state: string;
    pid?: number;
    alive: boolean;
    message?: string;
  };
  publicIp?: string;
  frozen: boolean;
  lastError?: IdentityConsoleError;
}

export interface IdentityConsoleOperationResult {
  ok: boolean;
  identity: IdentityConsoleItem;
  error?: IdentityConsoleError;
}
export interface IdentityConsoleLog { operation: string; identityId?: string; startedAt: string; completedAt: string; ok: boolean; errorCode?: string; errorMessage?: string; }

export interface IdentityConsoleApiResult<T> {
  ok: boolean;
  data?: T;
  error?: IdentityConsoleError;
}
