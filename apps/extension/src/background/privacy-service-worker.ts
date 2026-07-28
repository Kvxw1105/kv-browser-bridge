import { enforceNetworkPrivacy } from './network-privacy.js';

const privacy = await enforceNetworkPrivacy();
console.info('[kv-browser-bridge-extension]', JSON.stringify({
  event: privacy.error ? 'network_privacy_failed' : 'network_privacy_applied',
  at: new Date().toISOString(),
  privacy,
}));

await import('./service-worker.js');
