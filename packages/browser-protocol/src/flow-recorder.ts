export type PageFingerprint = {
  url: string;
  viewport: { width: number; height: number; devicePixelRatio: number };
};

export type HybridTarget = {
  selector?: string;
  xpath?: string;
  role?: string;
  name?: string;
  x?: number;
  y?: number;
  xRatio?: number;
  yRatio?: number;
};

export type FlowEvent = {
  kind: 'agent_action' | 'human_click' | 'human_input' | 'note' | 'blocker';
  at: string;
  page?: PageFingerprint;
  target?: HybridTarget;
  action?: string;
  params?: Record<string, unknown>;
  code?: string;
  message?: string;
};

export type RecordingSession = {
  id: string;
  intent: string;
  startedAt: string;
  tabId: number;
  events: FlowEvent[];
};

export function redactRecordedInput(value: string, kind: string): { redacted: boolean; value?: string; length: number; kind: string } {
  const sensitive = /password|passcode|otp|token|secret|verification/i.test(kind);
  return sensitive ? { redacted: true, length: value.length, kind } : { redacted: false, value, length: value.length, kind };
}

export function compileWorkflow(session: RecordingSession) {
  const steps = session.events
    .filter((event) => event.kind === 'agent_action' || event.kind === 'human_click' || event.kind === 'human_input')
    .map((event, index) => ({
      id: `step-${index + 1}`,
      source: event.kind.startsWith('human_') ? 'human' : 'agent',
      action: event.action ?? event.kind.replace('human_', ''),
      strategy: event.target?.selector || event.target?.role ? 'hybrid' : 'coordinate',
      page: event.page,
      target: {
        semantic: { selector: event.target?.selector, xpath: event.target?.xpath, role: event.target?.role, name: event.target?.name },
        geometry: { x: event.target?.x, y: event.target?.y, xRatio: event.target?.xRatio, yRatio: event.target?.yRatio },
      },
      params: event.params,
    }));
  const checkpoints = session.events
    .filter((event) => event.kind === 'blocker')
    .map((event, index) => ({ id: `checkpoint-${index + 1}`, kind: 'human_guidance', reason: event.code ?? 'UNKNOWN_BLOCKER', message: event.message ?? '' }));
  return { version: 1, id: session.id, intent: session.intent, tabId: session.tabId, startedAt: session.startedAt, steps, checkpoints, confidence: checkpoints.length ? 0.5 : 0.8 };
}
