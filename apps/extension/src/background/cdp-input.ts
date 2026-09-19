/**
 * CDP-driven trusted mouse input targeting a DOM node.
 *
 * Adapted from the Tencent/BrowserSkill (MIT, fa953dc) interaction approach:
 * resolve the target node, scroll it into view, compute a visible action
 * point, verify nothing covers it, then dispatch a real
 * Input.dispatchMouseEvent sequence so page handlers see trusted input. The
 * final-publish blocker stays a local rule and is checked before any input is
 * dispatched. Effect state tracks how far the input sequence got: `none`
 * (nothing dispatched — safe to retry), `unknown` (mousePressed was sent but
 * the outcome is unknowable — never retry), `committed`.
 *
 * No chrome.* API is used here: the CDP runner is injected so unit tests run
 * against a fake runner and never touch a real page.
 */

export type InputEffectState = 'none' | 'committed' | 'unknown';

export interface CdpRunner {
  ensureAttached(): Promise<void>;
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

export type ClickFailureCode =
  | 'STALE_REF'
  | 'ELEMENT_NOT_FOUND'
  | 'ELEMENT_HIDDEN'
  | 'ELEMENT_COVERED'
  | 'PREPUBLISH_BLOCKED'
  | 'INPUT_CANCELLED'
  | 'INPUT_DISPATCH_FAILED'
  | 'INPUT_DISCONNECTED';

export interface ClickFailure {
  code: ClickFailureCode;
  message: string;
  effectState: InputEffectState;
  details?: Record<string, unknown>;
}

export type ClickOutcome =
  | { ok: true; effectState: 'committed'; x: number; y: number; tag?: string; text?: string }
  | { ok: false; error: ClickFailure };

export interface ResolvedInputTarget {
  objectId: string;
  x: number;
  y: number;
  tag: string;
  text: string;
  publishBlocked: boolean;
}

export interface ClickOptions {
  allowCommentSend?: boolean;
  signal?: AbortSignal;
}

const OBJECT_GROUP = 'kv-cdp-input';

/** Page-side probe: visibility, scroll into view, action point, publish text. */
function inputTargetProbe(this: Element, allowCommentSendControl: boolean): { error: string } | { x: number; y: number; tag: string; text: string; publishBlocked: boolean } {
  const element = this;
  if (!(element instanceof Element)) return { error: 'not_an_element' };
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  if (style.display === 'none' || style.visibility === 'hidden' || element.getAttribute('aria-hidden') === 'true' || rect.width === 0 || rect.height === 0) {
    return { error: 'hidden' };
  }
  (element as HTMLElement).scrollIntoView({ block: 'center', inline: 'center' });
  const after = element.getBoundingClientRect();
  const x = Math.round(after.left + after.width / 2);
  const y = Math.round(after.top + after.height / 2);
  const text = [element.textContent, element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('value')]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const explicitSafe = /\b(save draft|draft|preview|cancel|back)\b|草稿|预览|取消|返回/i.test(text);
  const finalPublish = /\b(publish|post|submit|release|send)\b|发布|提交|上线|发送/.test(text);
  const commentComposerContainsButton = Array.from(document.querySelectorAll('[contenteditable="true"]')).some((editor) => {
    let ancestor: Element | null = editor.parentElement;
    for (let depth = 0; ancestor && depth < 5; depth += 1, ancestor = ancestor.parentElement) {
      if (ancestor.contains(element)) return true;
    }
    return false;
  });
  const approvedCommentSend = allowCommentSendControl && text === '发送' && commentComposerContainsButton;
  return {
    x,
    y,
    tag: element.tagName.toLowerCase(),
    text: (element.textContent ?? '').trim().slice(0, 160),
    publishBlocked: finalPublish && !explicitSafe && !approvedCommentSend,
  };
}

/** Page-side containment probe: is `hit` inside `this` (or `this` itself)? */
function containmentProbe(this: Element, hit: Element): boolean {
  let node: Element | null = hit;
  while (node) {
    if (node === this) return true;
    if (this.contains && this.contains(node)) return true;
    const root = node.getRootNode();
    node = node.parentElement || (root instanceof ShadowRoot ? root.host : null);
  }
  return false;
}

function fail(code: ClickFailureCode, message: string, effectState: InputEffectState, details?: Record<string, unknown>): ClickFailure {
  return { code, message, effectState, ...(details ? { details } : {}) };
}

export function isClickFailure(value: ResolvedInputTarget | ClickFailure): value is ClickFailure {
  return 'code' in value && 'effectState' in value;
}

function clickFail(code: ClickFailureCode, message: string, effectState: InputEffectState, details?: Record<string, unknown>): ClickOutcome {
  return { ok: false, error: fail(code, message, effectState, details) };
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Resolve a backend node id to an input target: attach, resolve the node,
 * probe visibility/action point in the page, and verify the action point is
 * not covered. Returns a failure with effectState `none` when no input has
 * been dispatched.
 */
export async function resolveInputTarget(runner: CdpRunner, backendNodeId: number, options: ClickOptions = {}): Promise<ResolvedInputTarget | ClickFailure> {
  await runner.ensureAttached();
  let objectId: string;
  try {
    const resolved = await runner.send<{ object?: { objectId?: string } }>('DOM.resolveNode', { backendNodeId, objectGroup: OBJECT_GROUP });
    const candidate = resolved.object?.objectId;
    if (!candidate) return fail('ELEMENT_NOT_FOUND', 'Ref target no longer resolves to a page node', 'none', { backendNodeId });
    objectId = candidate;
  } catch {
    return fail('STALE_REF', 'Ref target could not be resolved in the current document', 'none', { backendNodeId });
  }

  let probe: ReturnType<typeof inputTargetProbe>;
  try {
    const reply = await runner.send<{ result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() { return (${inputTargetProbe.toString()}).apply(this, arguments); }`,
      arguments: [{ value: options.allowCommentSend === true }],
      returnByValue: true,
      awaitPromise: false,
    });
    if (reply.exceptionDetails) {
      return fail('ELEMENT_NOT_FOUND', reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text ?? 'Input target probe failed', 'none', { backendNodeId });
    }
    probe = reply.result?.value as ReturnType<typeof inputTargetProbe>;
  } catch {
    return fail('STALE_REF', 'Input target probe failed after the node disappeared', 'none', { backendNodeId });
  }
  if (probe == null || typeof probe !== 'object' || 'error' in probe) {
    const reason = probe && typeof probe === 'object' && 'error' in probe ? probe.error : 'not_an_element';
    if (reason === 'hidden') return fail('ELEMENT_HIDDEN', 'Element is hidden and cannot receive input', 'none', { backendNodeId });
    return fail('ELEMENT_NOT_FOUND', 'Input target is not an element', 'none', { backendNodeId });
  }

  const covered = await verifyActionPoint(runner, backendNodeId, objectId, probe.x, probe.y);
  if (covered) return covered;
  return { objectId, x: probe.x, y: probe.y, tag: probe.tag, text: probe.text, publishBlocked: probe.publishBlocked };
}

async function verifyActionPoint(runner: CdpRunner, backendNodeId: number, objectId: string, x: number, y: number): Promise<ClickFailure | null> {
  try {
    const hit = await runner.send<{ backendNodeId?: number }>('DOM.getNodeForLocation', { x, y, includeUserAgentShadowDOM: true });
    if (typeof hit.backendNodeId !== 'number' || hit.backendNodeId === backendNodeId) return null;
    const hitResolved = await runner.send<{ object?: { objectId?: string } }>('DOM.resolveNode', { backendNodeId: hit.backendNodeId, objectGroup: OBJECT_GROUP });
    const hitObjectId = hitResolved.object?.objectId;
    if (!hitObjectId) return null;
    const reply = await runner.send<{ result?: { value?: unknown }; exceptionDetails?: { text?: string } }>('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() { return (${containmentProbe.toString()}).apply(this, arguments); }`,
      arguments: [{ objectId: hitObjectId }],
      returnByValue: true,
      awaitPromise: false,
    });
    if (reply.result?.value === true) return null;
    return fail('ELEMENT_COVERED', 'Element action point is covered by another element', 'none', { backendNodeId, x, y });
  } catch {
    return fail('ELEMENT_COVERED', 'Element action point could not be verified', 'none', { backendNodeId, x, y });
  }
}

/**
 * Dispatch a trusted left click at the target's visible action point.
 * Effect state: `none` until mousePressed has been sent, `unknown` after
 * mousePressed if the sequence fails, `committed` after mouseReleased.
 */
export async function dispatchClick(runner: CdpRunner, backendNodeId: number, options: ClickOptions = {}): Promise<ClickOutcome> {
  if (aborted(options.signal)) return clickFail('INPUT_CANCELLED', 'Click cancelled before any input was dispatched', 'none', { backendNodeId });
  let target: ResolvedInputTarget | ClickFailure;
  try {
    target = await resolveInputTarget(runner, backendNodeId, options);
  } catch {
    return clickFail('INPUT_DISPATCH_FAILED', 'Click failed while resolving the input target', 'none', { backendNodeId });
  }
  if (isClickFailure(target)) return { ok: false, error: target };
  if (target.publishBlocked) {
    return clickFail('PREPUBLISH_BLOCKED', 'Clicking a final publish or submit control is disabled', 'none', { backendNodeId, text: target.text });
  }

  const point = (type: string, additional: Record<string, unknown> = {}) => ({
    type,
    x: target.x,
    y: target.y,
    button: 'left' as const,
    clickCount: 1,
    ...additional,
  });

  if (aborted(options.signal)) return clickFail('INPUT_CANCELLED', 'Click cancelled before any input was dispatched', 'none', { backendNodeId });
  try {
    await runner.send('Input.dispatchMouseEvent', point('mouseMoved'));
  } catch {
    return clickFail('INPUT_DISPATCH_FAILED', 'Click failed before mousePressed', 'none', { backendNodeId, x: target.x, y: target.y });
  }

  if (aborted(options.signal)) return clickFail('INPUT_CANCELLED', 'Click cancelled before mousePressed', 'none', { backendNodeId, x: target.x, y: target.y });
  try {
    await runner.send('Input.dispatchMouseEvent', point('mousePressed'));
  } catch {
    return clickFail('INPUT_DISPATCH_FAILED', 'Click failed before mousePressed', 'none', { backendNodeId, x: target.x, y: target.y });
  }

  // mousePressed was sent: the page may already have reacted.
  try {
    await runner.send('Input.dispatchMouseEvent', point('mouseReleased'));
  } catch {
    return clickFail('INPUT_DISCONNECTED', 'Connection lost after mousePressed; the click outcome is unknown', 'unknown', { backendNodeId, x: target.x, y: target.y });
  }
  return { ok: true, effectState: 'committed', x: target.x, y: target.y, tag: target.tag, text: target.text };
}
