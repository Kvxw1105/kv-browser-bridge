import { enforceNetworkPrivacy } from './network-privacy.js';
// Keep the bridge bootstrap out of Vite's document-oriented dynamic-import
// preloader. MV3 service workers do not expose `window` or `document`.
import './service-worker.js';

console.info('[kv-browser-bridge-extension]', JSON.stringify({ event: 'privacy_service_worker_loaded', at: new Date().toISOString() }));

async function bootstrap(): Promise<void> {
  const privacy = await enforceNetworkPrivacy();
  console.info('[kv-browser-bridge-extension]', JSON.stringify({
    event: privacy.error ? 'network_privacy_failed' : 'network_privacy_applied',
    at: new Date().toISOString(),
    privacy,
  }));
}

void bootstrap().catch((error) => {
  console.error('[kv-browser-bridge-extension]', JSON.stringify({
    event: 'privacy_bootstrap_failed',
    at: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
  }));
});
