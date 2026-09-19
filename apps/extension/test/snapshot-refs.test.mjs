import assert from 'node:assert/strict';
import test from 'node:test';
import { RefStore } from '../src/background/ref-store.ts';
import { RefGuardError, refObservationFromSnapshot, requireRefTarget, storeObservation } from '../src/background/observation-store.ts';

/**
 * Focused offline tests for the browser_snapshot -> RefStore integration:
 * refs rendered by a successful VOM snapshot are stored atomically with their
 * identity/runtime-session/tab/frame ownership, and refs from an older
 * snapshot generation are rejected (stale-ref rejection). No CDP, transport,
 * identity credential, or VOM package dependency.
 */

const OWNER = { identityId: 'identity-a', runtimeSessionId: 'session-1' };
const TAB = 5;

test('refs of a rendered snapshot populate the store with identity, session, tab and frame', () => {
  const store = new RefStore();
  storeObservation(store, refObservationFromSnapshot([
    { ref: 'e1', backendNodeId: 11, frameId: 'frame-root' },
    { ref: 'e2', backendNodeId: 12, frameId: 'frame-1' },
  ], TAB, OWNER));
  assert.equal(store.revision, 1);
  const e1 = store.resolve('e1', { ...OWNER, tabId: TAB });
  assert.ok(e1, 'stored snapshot ref must resolve for its owner');
  assert.equal(e1.backendNodeId, 11);
  assert.equal(e1.identityId, OWNER.identityId);
  assert.equal(e1.runtimeSessionId, OWNER.runtimeSessionId);
  assert.equal(e1.tabId, TAB);
  assert.equal(e1.frameId, 'frame-root');
  assert.equal(e1.generation, 1);
  assert.equal(store.resolve('e2', { ...OWNER, tabId: TAB })?.frameId, 'frame-1', 'each ref keeps its own frameId');
});

test('snapshot refs without a frame are stored without frameId', () => {
  const store = new RefStore();
  storeObservation(store, refObservationFromSnapshot([{ ref: 'e1', backendNodeId: 11 }], TAB, OWNER));
  assert.equal(store.resolve('e1', { ...OWNER, tabId: TAB })?.frameId, undefined);
});

test('a fresh snapshot atomically replaces the previous generation', () => {
  const store = new RefStore();
  storeObservation(store, refObservationFromSnapshot([{ ref: 'e1', backendNodeId: 11, frameId: 'f' }], TAB, OWNER));
  const firstGeneration = store.revision;
  storeObservation(store, refObservationFromSnapshot([
    { ref: 'e1', backendNodeId: 99, frameId: 'f' },
    { ref: 'e2', backendNodeId: 12, frameId: 'f' },
  ], TAB, OWNER));
  assert.equal(store.revision, firstGeneration + 1);
  assert.equal(store.resolve('e1', { ...OWNER, tabId: TAB })?.backendNodeId, 99, 'same ref now points at the fresh node');
  assert.ok(store.resolve('e2', { ...OWNER, tabId: TAB }), 'new ref of the fresh generation resolves');
});

test('refs from a previous snapshot generation are rejected (stale-ref rejection)', () => {
  const store = new RefStore();
  storeObservation(store, refObservationFromSnapshot([{ ref: 'e1', backendNodeId: 11, frameId: 'f' }], TAB, OWNER));
  const staleGeneration = store.revision;
  storeObservation(store, refObservationFromSnapshot([{ ref: 'e1', backendNodeId: 99, frameId: 'f' }], TAB, OWNER));
  assert.equal(
    store.resolve('e1', { ...OWNER, tabId: TAB, generation: staleGeneration }),
    null,
    'ref pinned to the stale generation must not resolve',
  );
  assert.throws(
    () => requireRefTarget(store, { ref: 'e1', generation: staleGeneration }, OWNER, TAB),
    (error) => error instanceof RefGuardError && error.code === 'STALE_REF' && error.details.generation === staleGeneration,
  );
});

test('a ref dropped by a fresh snapshot becomes stale', () => {
  const store = new RefStore();
  storeObservation(store, refObservationFromSnapshot([
    { ref: 'e1', backendNodeId: 11, frameId: 'f' },
    { ref: 'e2', backendNodeId: 12, frameId: 'f' },
  ], TAB, OWNER));
  storeObservation(store, refObservationFromSnapshot([{ ref: 'e1', backendNodeId: 11, frameId: 'f' }], TAB, OWNER));
  assert.equal(store.resolve('e2', { ...OWNER, tabId: TAB }), null, 'dropped ref no longer resolves');
  assert.throws(
    () => requireRefTarget(store, { ref: 'e2' }, OWNER, TAB),
    (error) => error instanceof RefGuardError && error.code === 'STALE_REF',
  );
});

test('stored snapshot refs cannot be resolved by another identity, session, or tab', () => {
  const store = new RefStore();
  storeObservation(store, refObservationFromSnapshot([{ ref: 'e1', backendNodeId: 11, frameId: 'f' }], TAB, OWNER));
  assert.equal(store.resolve('e1', { identityId: 'identity-b', runtimeSessionId: OWNER.runtimeSessionId, tabId: TAB }), null);
  assert.equal(store.resolve('e1', { identityId: OWNER.identityId, runtimeSessionId: 'session-2', tabId: TAB }), null);
  assert.equal(store.resolve('e1', { ...OWNER, tabId: TAB + 1 }), null);
});

test('@-prefixed snapshot refs are canonicalised on storage', () => {
  const store = new RefStore();
  storeObservation(store, refObservationFromSnapshot([{ ref: '@e7', backendNodeId: 11, frameId: 'f' }], TAB, OWNER));
  assert.ok(store.resolve('e7', { ...OWNER, tabId: TAB }));
  assert.ok(store.resolve('@e7', { ...OWNER, tabId: TAB }));
});

test('malformed snapshot refs are skipped, and an empty observation still invalidates stale refs', () => {
  const store = new RefStore();
  storeObservation(store, refObservationFromSnapshot([{ ref: 'e1', backendNodeId: 11, frameId: 'f' }], TAB, OWNER));
  storeObservation(store, refObservationFromSnapshot([
    { ref: '   ', backendNodeId: 21, frameId: 'f' },
    { ref: 'e2', backendNodeId: 0, frameId: 'f' },
  ], TAB, OWNER));
  assert.equal(store.size(), 0, 'only malformed refs in the fresh observation -> nothing stored');
  assert.equal(store.revision, 2, 'the fresh observation still bumps the generation');
  assert.equal(store.resolve('e1', { ...OWNER, tabId: TAB }), null, 'previous snapshot refs are dropped');
});
