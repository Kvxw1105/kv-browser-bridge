/**
 * One upload transaction with an explicit browser-side commit boundary.
 *
 * Adapted from Tencent/BrowserSkill (MIT, fixed commit fa953dc)
 * `apps/extension/src/tools/file-input-transaction.ts`: the arm-interception →
 * arm-probe → trigger → resolve-input → set-files → cleanup state machine is
 * reused, but ownership is local to the Kv Browser Bridge: the transaction is
 * bound to a tab (and optionally a RefStore-resolved ref), uses the existing
 * chrome.debugger-backed CDP runner, and reuses the trusted click path from
 * cdp-input. Files are validated before any upload.
 *
 * Effect state: `none` (nothing dispatched — safe to retry), `unknown` (the
 * chooser was activated / files may have been set — never retry), `committed`
 * (files were set). A timeout after chooser activation returns `unknown`; the
 * transaction keeps its cleanup and never auto-retries.
 *
 * SHA-256/existence validation runs when a file-io adapter is provided (the
 * test suite and Node callers supply one); an MV3 service worker has no
 * filesystem, so the extension enforces the structural rules (absolute path,
 * content-package containment, manifest completeness, adapter limit) and any
 * hash verification is explicitly reported as not performed.
 */

import { dispatchClick, type CdpRunner } from './cdp-input.ts';

export type UploadEffectState = 'none' | 'committed' | 'unknown';
export type UploadPhase =
  | 'validate'
  | 'arm_interception'
  | 'arm_input_probe'
  | 'trigger'
  | 'resolve_input'
  | 'set_files'
  | 'cleanup';

export interface UploadResult {
  tabId: number;
  fileNames: string[];
  effectState: UploadEffectState;
  phase: UploadPhase;
  ok: boolean;
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
}

export interface UploadManifestEntry {
  path: string;
  sha256: string;
}

export interface UploadManifest {
  files: UploadManifestEntry[];
}

export interface UploadValidation {
  packageRoot: string;
  manifest: UploadManifest;
  maxFiles?: number;
}

/** Filesystem access is injected so the validator runs anywhere (test/Node).
 * An MV3 service worker has no filesystem and omits it. */
export interface UploadFileIO {
  stat(path: string): Promise<{ size: number } | null>;
  sha256(path: string): Promise<string>;
}

export type UploadValidationResult =
  | { ok: true; verifiedHashes: boolean }
  | { ok: false; code: 'FILE_VALIDATION_FAILED'; message: string; details: Record<string, unknown> };

export interface UploadRunner extends CdpRunner {
  onEvent?(handler: (method: string, params: unknown) => void): { dispose(): void };
}

export interface UploadTransactionOptions {
  runner: UploadRunner;
  tabId: number;
  /** Upload control resolved through the RefStore (or a locator). */
  backendNodeId: number;
  ref?: string;
  frameId?: string;
  files: string[];
  validation?: UploadValidation;
  io?: UploadFileIO;
  timeoutMs: number;
  signal?: AbortSignal;
  activationGraceMs?: number;
}

export const DEFAULT_UPLOAD_LIMIT = 16;

const CLEANUP_TIMEOUT_MS = 1_000;
const DEFAULT_ACTIVATION_GRACE_MS = 1_000;
const PROBE_INTERVAL_MS = 20;

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isWindowsAbsolute(path: string): boolean {
  return path.length >= 3 && /^[a-zA-Z]:$/.test(path.slice(0, 2)) && (path[2] === '\\' || path[2] === '/');
}

function normalizeWindowsPath(path: string): string {
  return path.replace(/\//g, '\\').replace(/\\+$/, '');
}

/** Reject any path segment that could escape the package root. */
function hasTraversal(path: string): boolean {
  return path.split(/[\\/]/).includes('..');
}

function isWithinPackageRoot(file: string, packageRoot: string): boolean {
  const root = normalizeWindowsPath(packageRoot).toLowerCase();
  const candidate = normalizeWindowsPath(file).toLowerCase();
  if (candidate === root) return false;
  return candidate.startsWith(root + '\\');
}

export async function validateUploadFiles(files: string[], validation: UploadValidation, io?: UploadFileIO): Promise<UploadValidationResult> {
  const fail = (message: string, details: Record<string, unknown>): UploadValidationResult => ({ ok: false, code: 'FILE_VALIDATION_FAILED', message, details });
  if (!files.length) return fail('files must not be empty', { files });
  const maxFiles = validation.maxFiles ?? DEFAULT_UPLOAD_LIMIT;
  if (files.length > maxFiles) return fail(`upload exceeds the adapter limit of ${maxFiles} files`, { files: files.length, maxFiles });

  const packageRoot = typeof validation.packageRoot === 'string' ? validation.packageRoot : '';
  if (!isWindowsAbsolute(packageRoot)) return fail('packageRoot must be an absolute local path', { packageRoot });
  if (!Array.isArray(validation.manifest?.files)) return fail('manifest.files must be an array of { path, sha256 }', {});

  const entries = new Map<string, UploadManifestEntry>();
  for (const entry of validation.manifest.files) {
    if (typeof entry?.path !== 'string' || typeof entry?.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(entry.sha256)) {
      return fail('manifest entries must be { path: string, sha256: 64-hex }', {});
    }
    entries.set(normalizeWindowsPath(entry.path).toLowerCase(), entry);
  }

  const missing: string[] = [];
  const outside: string[] = [];
  const untracked: string[] = [];
  for (const file of files) {
    if (typeof file !== 'string' || !isWindowsAbsolute(file)) {
      return fail('every upload file must be an absolute local path', { file });
    }
    if (hasTraversal(file)) return fail('upload file must not contain ".." path segments', { file });
    if (!isWithinPackageRoot(file, packageRoot)) outside.push(file);
    if (!entries.has(normalizeWindowsPath(file).toLowerCase())) untracked.push(file);
  }
  if (outside.length) return fail('every upload file must be inside the content package root', { outside });
  if (untracked.length) return fail('every upload file must have a manifest entry', { untracked });

  if (!io) {
    // No filesystem adapter: structural rules are enforced; hash/existence
    // verification cannot run here and is reported as not performed.
    return { ok: true, verifiedHashes: false };
  }

  const absent: string[] = [];
  const hashMismatch: string[] = [];
  for (const file of files) {
    const info = await io.stat(file);
    if (!info) { absent.push(file); continue; }
    const actual = await io.sha256(file);
    const expected = entries.get(normalizeWindowsPath(file).toLowerCase())?.sha256;
    if (expected && actual.toLowerCase() !== expected.toLowerCase()) hashMismatch.push(file);
  }
  if (absent.length) return fail('every upload file must exist on disk', { absent });
  if (hashMismatch.length) return fail('upload file SHA-256 does not match the manifest', { hashMismatch });
  return { ok: true, verifiedHashes: true };
}

/** Page-side probe installer: capture file-input activations under `this`. */
export function uploadInstallProbe(this: Element, key: string): boolean {
  const doc = this.ownerDocument;
  const owner = doc.defaultView;
  if (!owner) return false;
  const state: { inputs: Element[]; listener: ((event: Event) => void) | null } = { inputs: [], listener: null };
  Object.defineProperty(owner, key, { value: state, configurable: true });
  state.listener = (event) => {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const candidate = (path[0] || event.target) as Element | null;
    if (candidate && candidate.nodeType === 1 && candidate.localName === 'input' && (candidate as HTMLInputElement).type === 'file') {
      if (!state.inputs.includes(candidate)) state.inputs.push(candidate);
      event.preventDefault();
    }
  };
  doc.addEventListener('click', state.listener, true);
  return true;
}

/** Page-side probe summary: how many file inputs did the trigger activate? */
export function uploadSummaryProbe(this: Element, key: string): { count: number; multiple: boolean } {
  const state = (this.ownerDocument.defaultView as unknown as Record<string, unknown> | null)?.[key] as { inputs?: Element[] } | undefined;
  if (!state?.inputs) return { count: 0, multiple: false };
  const first = state.inputs[0] as HTMLInputElement | undefined;
  return { count: state.inputs.length, multiple: first?.multiple === true };
}

/** Page-side probe: return the activated file input object for describing. */
export function uploadInputProbe(this: Element, key: string): Element | null {
  const state = (this.ownerDocument.defaultView as unknown as Record<string, unknown> | null)?.[key] as { inputs?: Element[] } | undefined;
  return state?.inputs?.[0] ?? null;
}

/** Page-side probe cleanup: remove the listener and the window state. */
export function uploadCleanupProbe(this: Element, key: string): boolean {
  const owner = this.ownerDocument.defaultView as unknown as Record<string, unknown> | null;
  const state = owner?.[key] as { listener?: ((event: Event) => void) | null } | undefined;
  if (state?.listener) this.ownerDocument.removeEventListener('click', state.listener, true);
  if (owner && key in owner) delete owner[key];
  return true;
}

class BoundedWaitError extends Error {
  readonly kind: 'timeout' | 'aborted';
  constructor(kind: 'timeout' | 'aborted', message: string) {
    super(message);
    this.kind = kind;
  }
}

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

async function waitBounded<T>(promise: Promise<T>, deadline: number, signal: AbortSignal | undefined, timeoutMessage: string): Promise<T> {
  const remaining = remainingMs(deadline);
  if (aborted(signal)) throw new BoundedWaitError('aborted', 'upload cancelled');
  if (remaining === 0) throw new BoundedWaitError('timeout', timeoutMessage);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const boundary = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new BoundedWaitError('timeout', timeoutMessage)), remaining);
    if (signal) {
      onAbort = () => reject(new BoundedWaitError('aborted', 'upload cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([promise, boundary]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

interface RuntimeReply {
  result?: { value?: unknown; objectId?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

async function callOnNode(runner: UploadRunner, objectId: string, func: (...args: any[]) => unknown, args: unknown[], returnByValue: boolean): Promise<RuntimeReply> {
  return runner.send<RuntimeReply>('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function() { return (${func.toString()}).apply(this, arguments); }`,
    arguments: args.map((value) => ({ value })),
    returnByValue,
    awaitPromise: false,
  });
}

export async function uploadThroughActivatedFileInput(options: UploadTransactionOptions): Promise<UploadResult> {
  const { runner, tabId, files, timeoutMs, signal } = options;
  const fileNames = files.map(basename);
  const deadline = Date.now() + timeoutMs;
  const graceMs = options.activationGraceMs ?? DEFAULT_ACTIVATION_GRACE_MS;
  const make = (ok: boolean, effectState: UploadEffectState, phase: UploadPhase, extra: Partial<UploadResult> = {}): UploadResult => ({
    tabId,
    fileNames,
    effectState,
    phase,
    ok,
    ...extra,
  });
  let outcome: UploadResult = make(false, 'none', 'cleanup', { code: 'UPLOAD_UNKNOWN', message: 'upload transaction ended without an outcome' });

  // Validation must pass before anything touches the page.
  if (options.validation) {
    const validated = await validateUploadFiles(files, options.validation, options.io);
    if (!validated.ok) {
      outcome = make(false, 'none', 'validate', { code: validated.code, message: validated.message, details: validated.details });
      return outcome;
    }
  }
  if (aborted(signal)) {
    outcome = make(false, 'none', 'validate', { code: 'UPLOAD_CANCELLED', message: 'upload cancelled before arming', details: { ref: options.ref } });
    return outcome;
  }

  const objectGroup = `kv-upload-${crypto.randomUUID()}`;
  const stateKey = `__kvUpload_${crypto.randomUUID().replaceAll('-', '')}`;
  const chooserEvents: Array<{ frameId?: string; backendNodeId?: number; mode?: 'selectSingle' | 'selectMultiple' }> = [];
  let interceptionArmed = false;
  let probeArmed = false;
  let triggerObjectId: string | undefined;
  let cleanupFailed = false;

  const subscription = runner.onEvent?.((method, raw) => {
    if (method !== 'Page.fileChooserOpened') return;
    const event = raw as { frameId?: string; backendNodeId?: number; mode?: 'selectSingle' | 'selectMultiple' };
    chooserEvents.push(event);
  });

  try {
    try {
      await waitBounded(
        runner.send('Page.setInterceptFileChooserDialog', { enabled: true }),
        deadline,
        signal,
        'arming native file chooser interception timed out',
      );
      interceptionArmed = true;
    } catch (error) {
      outcome = make(false, 'none', 'arm_interception', {
        code: 'UPLOAD_ARM_FAILED',
        message: error instanceof Error ? error.message : String(error),
        details: { ref: options.ref, timeout: error instanceof BoundedWaitError && error.kind === 'timeout' },
      });
      return outcome;
    }

    try {
      const resolved = await waitBounded(
        runner.send<{ object?: { objectId?: string } }>('DOM.resolveNode', { backendNodeId: options.backendNodeId, objectGroup }),
        deadline,
        signal,
        'resolving upload trigger timed out',
      );
      triggerObjectId = resolved.object?.objectId;
      if (!triggerObjectId) throw new Error('DOM.resolveNode returned no trigger objectId');
      const armed = await waitBounded(
        callOnNode(runner, triggerObjectId, uploadInstallProbe, [stateKey], true),
        deadline,
        signal,
        'arming file input probe timed out',
      );
      if (armed.exceptionDetails) throw new Error(armed.exceptionDetails.exception?.description ?? armed.exceptionDetails.text ?? 'probe failed');
      if (armed.result?.value !== true) throw new Error('file input probe did not arm');
      probeArmed = true;
    } catch (error) {
      outcome = make(false, 'none', 'arm_input_probe', {
        code: 'UPLOAD_ARM_FAILED',
        message: error instanceof Error ? error.message : String(error),
        details: { ref: options.ref, timeout: error instanceof BoundedWaitError && error.kind === 'timeout' },
      });
      return outcome;
    }

    const click = await dispatchClick(runner, options.backendNodeId, { signal });
    if (!click.ok) {
      outcome = make(false, click.error.effectState, 'trigger', { code: click.error.code, message: click.error.message, details: click.error.details });
      return outcome;
    }

    // Wait for chooser activation or the frame-scoped probe summary.
    const activationDeadline = Math.min(deadline, Date.now() + graceMs);
    let summary: { count: number; multiple: boolean } = { count: 0, multiple: false };
    try {
      while (Date.now() < activationDeadline && chooserEvents.length === 0) {
        const reply = await callOnNode(runner, triggerObjectId, uploadSummaryProbe, [stateKey], true);
        if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text ?? 'probe failed');
        const value = reply.result?.value as { count?: unknown; multiple?: unknown } | undefined;
        summary = {
          count: typeof value?.count === 'number' ? value.count : 0,
          multiple: value?.multiple === true,
        };
        if (summary.count > 0) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(PROBE_INTERVAL_MS, remainingMs(activationDeadline))));
      }
    } catch (error) {
      outcome = make(false, 'none', 'resolve_input', {
        code: 'UPLOAD_PROBE_FAILED',
        message: error instanceof Error ? error.message : String(error),
        details: { ref: options.ref },
      });
      return outcome;
    }

    if (chooserEvents.length > 1) {
      outcome = make(false, 'none', 'resolve_input', { code: 'UPLOAD_NOT_ACTIVATED', message: 'upload trigger activated more than one file chooser', details: { ref: options.ref } });
      return outcome;
    }

    let backendNodeId: number | undefined;
    let multiple = summary.multiple;
    const chooser = chooserEvents[0];
    if (chooser) {
      if (options.frameId && chooser.frameId && chooser.frameId !== options.frameId) {
        outcome = make(false, 'none', 'resolve_input', { code: 'UPLOAD_NOT_ACTIVATED', message: 'upload trigger activated a chooser in a different frame', details: { ref: options.ref } });
        return outcome;
      }
      if (typeof chooser.backendNodeId !== 'number') {
        outcome = make(false, 'none', 'resolve_input', { code: 'UPLOAD_NOT_ACTIVATED', message: 'upload trigger invoked a non-input file picker', details: { ref: options.ref } });
        return outcome;
      }
      backendNodeId = chooser.backendNodeId;
      multiple = chooser.mode === 'selectMultiple';
    } else {
      if (summary.count !== 1) {
        outcome = make(false, 'none', 'resolve_input', {
          code: 'UPLOAD_NOT_ACTIVATED',
          message: summary.count === 0 ? 'upload trigger did not activate an input[type=file]' : 'upload trigger activated more than one input[type=file]',
          details: { ref: options.ref, count: summary.count },
        });
        return outcome;
      }
      const input = await callOnNode(runner, triggerObjectId, uploadInputProbe, [stateKey], false);
      if (input.exceptionDetails) throw new Error(input.exceptionDetails.exception?.description ?? input.exceptionDetails.text ?? 'probe failed');
      if (!input.result?.objectId) throw new Error('activated file input returned no objectId');
      const described = await runner.send<{ node?: { backendNodeId?: number } }>('DOM.describeNode', { objectId: input.result.objectId });
      if (typeof described.node?.backendNodeId !== 'number') throw new Error('DOM.describeNode returned no file input backendNodeId');
      backendNodeId = described.node.backendNodeId;
    }

    if (!multiple && files.length !== 1) {
      outcome = make(false, 'none', 'resolve_input', { code: 'UPLOAD_COUNT_MISMATCH', message: 'file input accepts exactly one file', details: { ref: options.ref, files: files.length } });
      return outcome;
    }

    // The chooser has been activated: a timeout here leaves an unknown effect.
    try {
      await waitBounded(
        runner.send('DOM.setFileInputFiles', { backendNodeId, files }),
        deadline,
        signal,
        'setting file input files timed out',
      );
    } catch (error) {
      outcome = make(false, 'unknown', 'set_files', {
        code: 'SET_FILE_INPUT_FAILED',
        message: error instanceof Error ? error.message : String(error),
        details: { ref: options.ref, timeout: error instanceof BoundedWaitError && error.kind === 'timeout' },
      });
      return outcome;
    }
    outcome = make(true, 'committed', 'set_files', { message: `set ${files.length} file${files.length === 1 ? '' : 's'}` });
    return outcome;
  } finally {
    subscription?.dispose();
    if (probeArmed && triggerObjectId) {
      try {
        await waitBounded(
          callOnNode(runner, triggerObjectId, uploadCleanupProbe, [stateKey], true),
          Date.now() + CLEANUP_TIMEOUT_MS,
          undefined,
          'cleaning file input probe timed out',
        );
      } catch {
        cleanupFailed = true;
      }
    }
    if (interceptionArmed) {
      try {
        await waitBounded(
          runner.send('Page.setInterceptFileChooserDialog', { enabled: false, cancel: true }),
          Date.now() + CLEANUP_TIMEOUT_MS,
          undefined,
          'disabling file chooser interception timed out',
        );
      } catch {
        cleanupFailed = true;
      }
    }
    try {
      await waitBounded(
        runner.send('Runtime.releaseObjectGroup', { objectGroup }),
        Date.now() + CLEANUP_TIMEOUT_MS,
        undefined,
        'releasing upload object group timed out',
      );
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed) {
      outcome = { ...outcome, details: { ...(outcome.details ?? {}), cleanup_state: 'failed' } };
    }
  }
}
