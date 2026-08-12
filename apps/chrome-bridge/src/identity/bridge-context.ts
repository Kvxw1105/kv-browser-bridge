import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BridgeDiscovery, BridgeIdentity, ExtensionHelloMessage } from '@kv-browser-bridge/browser-protocol';

const IDENTITY_SLUG = /^[a-z0-9][a-z0-9-]{2,63}$/;

export function bridgeIdentityFromEnv(env: NodeJS.ProcessEnv = process.env): BridgeIdentity | undefined {
  const identityId = env.KV_BROWSER_IDENTITY_ID;
  if (!identityId) return undefined;
  if (!IDENTITY_SLUG.test(identityId)) throw new Error('KV_BROWSER_IDENTITY_ID must be a stable lowercase slug.');
  return {
    identityId,
    workspaceId: optionalSlug(env.KV_BROWSER_WORKSPACE_ID, 'KV_BROWSER_WORKSPACE_ID'),
    platform: optionalSlug(env.KV_BROWSER_PLATFORM, 'KV_BROWSER_PLATFORM'),
    runtimeSessionId: optionalSlug(env.KV_BROWSER_RUNTIME_SESSION_ID, 'KV_BROWSER_RUNTIME_SESSION_ID'),
  };
}

export function bridgeConfigRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'KvBrowserBridge');
}

export function discoveryPathForIdentity(identity: BridgeIdentity | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const root = bridgeConfigRoot(env);
  return identity ? join(root, 'identities', identity.identityId, 'bridge.json') : join(root, 'bridge.json');
}

export function publicSessionPathForIdentity(identity: BridgeIdentity, env: NodeJS.ProcessEnv = process.env): string {
  return join(bridgeConfigRoot(env), 'sessions', `${identity.identityId}.json`);
}

export function publicSessionRecord(discovery: BridgeDiscovery): Record<string, unknown> {
  if (!discovery.identity) throw new Error('Identity discovery is required for a public session record.');
  return {
    schemaVersion: 1,
    identity: discovery.identity,
    pid: discovery.pid,
    startedAt: discovery.startedAt,
    protocolVersion: discovery.protocolVersion,
  };
}

export function validateExtensionIdentityHello(expected: BridgeIdentity | undefined, hello: ExtensionHelloMessage): void {
  if (!expected) {
    if (hello.identity) throw new Error('Legacy Bridge received an unexpected identity-bound extension hello.');
    return;
  }
  if (!hello.identity) throw new Error(`Identity Bridge ${expected.identityId} requires an identity-bound extension hello.`);
  for (const field of ['identityId', 'workspaceId', 'platform', 'runtimeSessionId'] as const) {
    if (hello.identity[field] !== expected[field]) {
      throw new Error(`Extension identity ${field} does not match the Bridge process.`);
    }
  }
}

function optionalSlug(value: string | undefined, name: string): string | undefined {
  if (!value) return undefined;
  if (!IDENTITY_SLUG.test(value)) throw new Error(`${name} must be a lowercase slug.`);
  return value;
}
