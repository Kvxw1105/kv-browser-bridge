import assert from 'node:assert/strict';
import test from 'node:test';
import { normaliseRef, RefStore } from '../src/background/ref-store.ts';
import { RefGuardError, requireRefTarget, storeObservation } from '../src/background/observation-store.ts';

const OWNER_A = { identityId: 'identity-a', runtimeSessionId: 'session-1' };
const OWNER_B = { identityId: 'identity-b', runtimeSessionId: 'session-1' };

function resolve(store, ref, tabId, generation) {
  return store.resolve(ref, { identityId: OWNER_A.identityId, runtimeSessionId: OWNER_A.runtimeSessionId, tabId, ...(generation === undefined ? {} : { generation }) });
}

test('resolves a fresh ref with its backend node identity', () => {
  const store = new RefStore();
  store.replace([['e1', { backendNodeId: 11, tabId: 5 }], ['e2', { backendNodeId: 12, tabId: 5, frameId: 'frame-1' }]], OWNER_A);
  const entry = store.resolve('e1', { ...OWNER_A, tabId: 5 });
  assert.ok(entry, 'fresh ref must resolve');
  assert.equal(entry.backendNodeId, 11);
  assert.equal(entry.identityId, 'identity-a');
  assert.equal(entry.runtimeSessionId, 'session-1');
  assert.equal(entry.tabId, 5);
  assert.equal(entry.generation, 1);
  assert.equal(entry.ref, 'e1');
  const framed = store.resolve('e2', { ...OWNER_A, tabId: 5 });
  assert.equal(framed?.frameId, 'frame-1');
});

test('refuses a ref from another tab', () => {
  const store = new RefStore();
  store.replace([['e1', { backendNodeId: 11, tabId: 5 }]], OWNER_A);
  assert.equal(store.resolve('e1', { ...OWNER_A, tabId: 6 }), null);
});

test('navigation invalidation drops refs for the navigated tab only', () => {
  const store = new RefStore();
  store.replace([['e1', { backendNodeId: 11, tabId: 5 }], ['e2', { backendNodeId: 12, tabId: 7 }]], OWNER_A);
  store.invalidateTab(5);
  assert.equal(store.resolve('e1', { ...OWNER_A, tabId: 5 }), null, 'navigated tab ref must be invalidated');
  assert.ok(store.resolve('e2', { ...OWNER_A, tabId: 7 }), 'unrelated tab ref survives navigation');
});

test('refuses a ref from another identity', () => {
  const store = new RefStore();
  store.replace([['e1', { backendNodeId: 11, tabId: 5 }]], OWNER_A);
  assert.equal(store.resolve('e1', { ...OWNER_B, tabId: 5 }), null, 'different identity must not resolve');
  store.replace([['e1', { backendNodeId: 11, tabId: 5 }]], OWNER_B);
  assert.ok(store.resolve('e1', { ...OWNER_B, tabId: 5 }), 'owner identity resolves its own ref');
});

test('refuses a ref from another runtime session of the same identity', () => {
  const store = new RefStore();
  store.replace([['e1', { backendNodeId: 11, tabId: 5 }]], OWNER_A);
  assert.equal(
    store.resolve('e1', { identityId: OWNER_A.identityId, runtimeSessionId: 'session-2', tabId: 5 }),
    null,
    'different runtime session must not resolve',
  );
});

test('replace invalidates the previous generation', () => {
  const store = new RefStore();
  store.replace([['e1', { backendNodeId: 11, tabId: 5 }], ['e2', { backendNodeId: 12, tabId: 5 }]], OWNER_A);
  const firstGeneration = store.revision;
  assert.equal(firstGeneration, 1);
  store.replace([['e1', { backendNodeId: 99, tabId: 5 }]], OWNER_A);
  assert.equal(store.revision, 2);
  assert.equal(store.resolve('e1', { ...OWNER_A, tabId: 5, generation: firstGeneration }), null, 'ref pinned to the old generation is rejected');
  const fresh = store.resolve('e1', { ...OWNER_A, tabId: 5, generation: store.revision });
  assert.equal(fresh?.backendNodeId, 99);
  assert.equal(store.resolve('e2', { ...OWNER_A, tabId: 5 }), null, 'ref dropped by replace no longer resolves');
});

test('generation mismatch is rejected when pinned', () => {
  const store = new RefStore();
  store.replace([['e1', { backendNodeId: 11, tabId: 5 }]], OWNER_A);
  assert.ok(store.resolve('e1', { ...OWNER_A, tabId: 5, generation: 1 }));
  assert.equal(store.resolve('e1', { ...OWNER_A, tabId: 5, generation: 7 }), null);
});

test('session invalidation drops only that identity+runtime session', () => {
  const store = new RefStore();
  store.replace([['e1', { backendNodeId: 11, tabId: 5 }]], OWNER_A);
  store.replace([['e2', { backendNodeId: 21, tabId: 5 }]], OWNER_B);
  store.invalidateSession(OWNER_A);
  assert.equal(store.resolve('e1', { ...OWNER_A, tabId: 5 }), null);
  assert.ok(store.resolve('e2', { ...OWNER_B, tabId: 5 }), 'other identity refs survive session invalidation');
});

test('clear drops every ref', () => {
  const store = new RefStore();
  store.replace([['e1', { backendNodeId: 11, tabId: 5 }]], OWNER_A);
  store.clear();
  assert.equal(store.size(), 0);
  assert.equal(store.resolve('e1', { ...OWNER_A, tabId: 5 }), null);
});

test('normaliseRef canonicalises the @ prefix', () => {
  assert.equal(normaliseRef('@e3'), 'e3');
  assert.equal(normaliseRef('e3'), 'e3');
  const store = new RefStore();
  store.replace([['@e3', { backendNodeId: 11, tabId: 5 }]], OWNER_A);
  assert.ok(store.resolve('e3', { ...OWNER_A, tabId: 5 }));
});

test('storeObservation atomically replaces refs through the boundary', () => {
  const store = new RefStore();
  storeObservation(store, {
    ownership: OWNER_A,
    entries: [['e1', { backendNodeId: 11, tabId: 5 }], ['e2', { backendNodeId: 12, tabId: 5 }]],
  });
  assert.equal(store.revision, 1);
  assert.ok(store.resolve('e1', { ...OWNER_A, tabId: 5 }));
  storeObservation(store, { ownership: OWNER_A, entries: [['e3', { backendNodeId: 13, tabId: 5 }]] });
  assert.equal(store.revision, 2);
  assert.equal(store.resolve('e1', { ...OWNER_A, tabId: 5 }), null, 'old generation dropped');
  assert.ok(store.resolve('e3', { ...OWNER_A, tabId: 5 }));
});

test('requireRefTarget returns null without a ref param (selector path stays)', () => {
  const store = new RefStore();
  assert.equal(requireRefTarget(store, { selector: '#x' }, OWNER_A, 5), null);
});

test('requireRefTarget throws STALE_REF for an unknown ref and never falls back', () => {
  const store = new RefStore();
  assert.throws(
    () => requireRefTarget(store, { ref: 'e9', selector: '#fallback' }, OWNER_A, 5),
    (error) => error instanceof RefGuardError && error.code === 'STALE_REF' && error.details.ref === 'e9',
  );
});

test('requireRefTarget throws REF_SCOPE_MISMATCH for another identity or tab', () => {
  const store = new RefStore();
  store.replace([['e1', { backendNodeId: 11, tabId: 5 }]], OWNER_A);
  assert.throws(
    () => requireRefTarget(store, { ref: 'e1' }, { ...OWNER_B, runtimeSessionId: 'session-1' }, 5),
    (error) => error instanceof RefGuardError && error.code === 'REF_SCOPE_MISMATCH' && error.details.entryIdentityId === 'identity-a',
  );
  assert.throws(
    () => requireRefTarget(store, { ref: 'e1' }, OWNER_A, 6),
    (error) => error instanceof RefGuardError && error.code === 'REF_SCOPE_MISMATCH' && error.details.entryTabId === 5,
  );
});

test('requireRefTarget throws STALE_REF for a pinned outdated generation', () => {
  const store = new RefStore();
  store.replace([['e1', { backendNodeId: 11, tabId: 5 }]], OWNER_A);
  store.replace([['e1', { backendNodeId: 99, tabId: 5 }]], OWNER_A);
  assert.throws(
    () => requireRefTarget(store, { ref: 'e1', generation: 1 }, OWNER_A, 5),
    (error) => error instanceof RefGuardError && error.code === 'STALE_REF' && error.details.generation === 1 && error.details.observedGeneration === 2,
  );
  const target = requireRefTarget(store, { ref: 'e1', generation: 2 }, OWNER_A, 5);
  assert.equal(target?.entry.backendNodeId, 99);
});
