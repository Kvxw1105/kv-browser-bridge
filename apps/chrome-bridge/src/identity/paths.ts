import { homedir } from 'node:os';
import { join } from 'node:path';

export function defaultRuntimeRoot(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.KV_IDENTITY_RUNTIME_DIR) return env.KV_IDENTITY_RUNTIME_DIR;
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(base, 'KvBrowserBridge', 'identities');
  }
  const base = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(base, 'KvBrowserBridge', 'identities');
}

export function runtimePaths(rootDir: string, identityId: string): {
  identityDir: string;
  lockPath: string;
  receiptPath: string;
  staleDir: string;
} {
  const identityDir = join(rootDir, identityId, 'runtime');
  return {
    identityDir,
    lockPath: join(identityDir, 'session.lock.json'),
    receiptPath: join(identityDir, 'session-receipt.json'),
    staleDir: join(identityDir, 'stale-locks'),
  };
}
