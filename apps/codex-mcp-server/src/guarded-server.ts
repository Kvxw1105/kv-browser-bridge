import { installNetworkGuardOnBridgeClient } from './network-guarded-bridge.js';

installNetworkGuardOnBridgeClient();
await import('./server.js');
