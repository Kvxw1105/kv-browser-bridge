type Target = { selector?: string; xpath?: string; role?: string; name?: string; x?: number; y?: number; xRatio?: number; yRatio?: number };
type FlowEvent = { kind: 'agent_action' | 'human_click' | 'human_input' | 'note' | 'blocker'; at: string; page?: Record<string, unknown>; target?: Target; action?: string; params?: Record<string, unknown>; code?: string; message?: string };
type Session = { id: string; intent: string; tabId: number; startedAt: string; recordInputValues: boolean; events: FlowEvent[] };

let active: Session | null = null;

function id(): string { return `flow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
function sanitize(params: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...params };
  delete copy.__sessionId;
  if (typeof copy.text === 'string') copy.text = { redacted: true, length: copy.text.length };
  if (Array.isArray(copy.files)) copy.files = copy.files.map((file) => typeof file === 'string' ? file.split(/[\\/]/).pop() : file);
  return copy;
}
function draft(session: Session) {
  const steps = session.events.filter((event) => event.kind === 'agent_action' || event.kind === 'human_click' || event.kind === 'human_input').map((event, index) => ({
    id: `step-${index + 1}`,
    source: event.kind.startsWith('human_') ? 'human' : 'agent',
    action: event.action ?? event.kind.replace('human_', ''),
    strategy: event.target?.selector || event.target?.role ? 'hybrid' : 'coordinate',
    page: event.page,
    target: event.target,
    params: event.params,
  }));
  const checkpoints = session.events.filter((event) => event.kind === 'blocker').map((event, index) => ({ id: `checkpoint-${index + 1}`, kind: 'human_guidance', reason: event.code ?? 'UNKNOWN_BLOCKER', message: event.message ?? '' }));
  return { version: 1, id: session.id, intent: session.intent, tabId: session.tabId, startedAt: session.startedAt, steps, checkpoints, confidence: checkpoints.length ? 0.5 : 0.8 };
}

export async function startFlowRecording(tabId: number, intent: string, recordInputValues = false) {
  if (active) throw new Error(`Recording already active: ${active.id}`);
  active = { id: id(), intent, tabId, startedAt: new Date().toISOString(), recordInputValues, events: [] };
  await chrome.tabs.sendMessage(tabId, { type: 'KV_FLOW_RECORDING_START', recordInputValues }).catch(() => undefined);
  return { id: active.id, tabId, intent, startedAt: active.startedAt };
}
export function flowRecordingStatus() { return active ? { active: true, id: active.id, tabId: active.tabId, intent: active.intent, events: active.events.length } : { active: false }; }
export function recordFlowUserEvent(tabId: number, event: FlowEvent) { if (active?.tabId === tabId) active.events.push(event); }
export function recordFlowAgentAction(tabId: number, action: string, params: Record<string, unknown>, result?: unknown) {
  if (!active || active.tabId !== tabId || action.startsWith('record_')) return;
  const selector = typeof params.selector === 'string' ? params.selector : undefined;
  const xpath = typeof params.xpath === 'string' ? params.xpath : undefined;
  active.events.push({
    kind: 'agent_action',
    at: new Date().toISOString(),
    action,
    target: selector || xpath ? { selector, xpath } : undefined,
    params: { ...sanitize(params), result: typeof result === 'object' && result != null ? { recorded: true } : result },
  });
}
export function recordFlowBlocker(tabId: number, code: string, message: string) { if (active?.tabId === tabId) active.events.push({ kind: 'blocker', at: new Date().toISOString(), code, message }); }
export function recordFlowNote(tabId: number, message: string) { if (active?.tabId === tabId) active.events.push({ kind: 'note', at: new Date().toISOString(), message }); }
export async function stopFlowRecording(tabId: number) {
  if (!active) throw new Error('No recording is active');
  if (active.tabId !== tabId) throw new Error(`Recording belongs to tab ${active.tabId}`);
  const session = active; active = null;
  await chrome.tabs.sendMessage(tabId, { type: 'KV_FLOW_RECORDING_STOP' }).catch(() => undefined);
  const workflow = draft(session);
  await chrome.storage.local.set({ [`kv-flow-${workflow.id}`]: workflow, 'kv-flow-last': workflow });
  return workflow;
}
