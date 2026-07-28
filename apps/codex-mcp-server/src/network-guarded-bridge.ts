import { BridgeClient, BridgeError } from './bridge-client.js';
import { bridgeIdentityId } from './identity-selection.js';
import { NetworkGuardError } from './network-guard.js';
import { assertOperationalIdentityReady } from './operational-guard.js';

const STATUS_METHOD = 'browser_connection_status';
let installed = false;

export async function assertBridgeNetworkBeforeRequest(
  method: string,
  statusProvider: () => Promise<unknown>,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): Promise<void> {
  if (method === STATUS_METHOD) return;
  const status = await statusProvider();
  const identityId = bridgeIdentityId(status);
  if (!identityId) return;
  try {
    assertOperationalIdentityReady(identityId, status, env, platform);
  } catch (error) {
    if (error instanceof NetworkGuardError) {
      throw new BridgeError(
        'INVALID_REQUEST',
        error.message,
        false,
        { networkCode: error.code, ...(error.details ?? {}) },
      );
    }
    throw error;
  }
}

export function installNetworkGuardOnBridgeClient(): void {
  if (installed) return;
  const originalRequest = BridgeClient.prototype.request;
  BridgeClient.prototype.request = async function guardedRequest(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<unknown> {
    await assertBridgeNetworkBeforeRequest(
      method,
      () => originalRequest.call(this, STATUS_METHOD, {}, timeoutMs),
    );
    return originalRequest.call(this, method, params, timeoutMs);
  };
  installed = true;
}
