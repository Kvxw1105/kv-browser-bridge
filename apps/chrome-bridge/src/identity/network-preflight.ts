import { createConnection } from 'node:net';
import type { IdentityManifest } from './model.js';

export interface ProxyReachabilityResult {
  ok: boolean;
  host: string;
  port: number;
  latencyMs?: number;
  error?: { code: string; message: string };
}

export function probeProxyEndpoint(
  manifest: IdentityManifest,
  timeoutMs = 5_000,
): Promise<ProxyReachabilityResult> {
  const { host, port } = manifest.proxy;
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (result: ProxyReachabilityResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ ok: true, host, port, latencyMs: Date.now() - startedAt }));
    socket.once('timeout', () => finish({ ok: false, host, port, error: { code: 'PROXY_TIMEOUT', message: `Proxy endpoint did not accept a TCP connection within ${timeoutMs}ms.` } }));
    socket.once('error', (error) => finish({ ok: false, host, port, error: { code: 'PROXY_UNREACHABLE', message: error.message } }));
  });
}
