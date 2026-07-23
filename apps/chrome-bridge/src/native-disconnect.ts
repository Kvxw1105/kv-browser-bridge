import type { BridgeError, BrowserRequest } from '@kv-browser-bridge/browser-protocol';

/** Policy consumed directly by ChromeBridge.handleNativeError. */
export function nativeDisconnectErrorFor(operationClass: BrowserRequest['operationClass'], message: string): BridgeError {
  return operationClass === 'non_idempotent_write'
    ? { code: 'UNKNOWN_OUTCOME', message: `Chrome Native Messaging disconnected after a write may have started: ${message}`, retryable: false }
    : { code: 'CONNECTION_CLOSED', message: `Chrome Native Messaging disconnected: ${message}`, retryable: true };
}
