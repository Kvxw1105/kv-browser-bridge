import { enforceNetworkPrivacy } from './network-privacy.js';

async function bootstrap(): Promise<void> {
  const privacy = await enforceNetworkPrivacy();
  console.info('[kv-browser-bridge-extension]', JSON.stringify({
    event: privacy.error ? 'network_privacy_failed' : 'network_privacy_applied',
    at: new Date().toISOString(),
    privacy,
  }));
  await import('./service-worker.js');
}

void bootstrap().catch((error) => {
  console.error('[kv-browser-bridge-extension]', JSON.stringify({
    event: 'privacy_bootstrap_failed',
    at: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
  }));
});
