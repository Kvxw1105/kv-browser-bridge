import {
  COMPUTER_PROTOCOL_VERSION,
  MAX_SEQUENCE_STEPS,
  MAX_SEQUENCE_TIMEOUT_MS,
  SEQUENCE_ID_PATTERN,
  STEP_ID_PATTERN,
  type ActionEnvelope,
  type ActionReceipt,
  type ComputerActionSequence,
  type ComputerActionStep,
  type RiskLevel,
  type SequenceError,
  type SequenceReceipt,
  validateActionEnvelope,
} from './computer-contracts.js';

export type ExecuteSequenceStep = (envelope: ActionEnvelope) => Promise<ActionReceipt>;

export type ActionSequenceExecutorOptions = {
  defaultStepTimeoutMs?: number;
  onStepReceipt?: (receipt: ActionReceipt) => Promise<void>;
  now?: () => number;
};

const allowedActionTypes = new Set([
  'browser_command',
  'focus_window',
  'invoke_ref',
  'set_value_ref',
  'launch_app',
]);

const nestedActionTypes = new Set([
  'sequence',
  'execute_sequence',
  'computer_execute_sequence',
]);

const riskRank: Record<RiskLevel, number> = {
  read: 0,
  'reversible-write': 1,
  'external-write': 2,
  destructive: 3,
};

export class ActionSequenceExecutor {
  private readonly defaultStepTimeoutMs: number;
  private readonly onStepReceipt?: (receipt: ActionReceipt) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly executeStep: ExecuteSequenceStep,
    options: ActionSequenceExecutorOptions = {},
  ) {
    this.defaultStepTimeoutMs = clampStepTimeout(options.defaultStepTimeoutMs ?? 30_000);
    this.onStepReceipt = options.onStepReceipt;
    this.now = options.now ?? Date.now;
  }

  async execute(sequence: ComputerActionSequence): Promise<SequenceReceipt> {
    const startedAtMs = this.now();
    const startedAt = toIso(startedAtMs);
    const steps = Array.isArray(sequence?.steps) ? sequence.steps : [];
    const sequenceId = typeof sequence?.sequenceId === 'string' ? sequence.sequenceId : '';
    const risk = highestRisk(steps);
    const validationErrors = validateActionSequence(sequence, this.defaultStepTimeoutMs);
    if (validationErrors.length > 0) {
      const primary = validationErrors[0]!;
      return {
        protocolVersion: COMPUTER_PROTOCOL_VERSION,
        sequenceId,
        startedAt,
        finishedAt: toIso(this.now()),
        status: 'blocked',
        risk,
        totalSteps: steps.length,
        completedSteps: 0,
        ...(primary.stepId ? { stoppedAtStep: primary.stepId } : {}),
        ...(steps.length > 0 ? { skippedSteps: validStepIds(steps) } : {}),
        stepReceipts: [],
        error: combineValidationErrors(validationErrors),
      };
    }

    const totalTimeoutMs = resolveTotalTimeout(sequence, this.defaultStepTimeoutMs);
    const deadline = startedAtMs + totalTimeoutMs;
    const stepReceipts: ActionReceipt[] = [];
    let completedSteps = 0;

    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index]!;
      const remainingMs = deadline - this.now();
      if (remainingMs <= 0) {
        return stoppedReceipt({
          sequence,
          startedAt,
          risk,
          stepReceipts,
          completedSteps,
          stoppedAtStep: step.stepId,
          skippedSteps: steps.slice(index).map((item) => item.stepId),
          error: sequenceError('SEQUENCE_TIMEOUT', `Sequence ${sequence.sequenceId} reached its total timeout before step ${step.stepId}.`, step.stepId),
          now: this.now,
        });
      }

      const requestedStepTimeout = step.timeoutMs ?? this.defaultStepTimeoutMs;
      const envelope = toActionEnvelope(
        sequence.sequenceId,
        step,
        Math.max(1, Math.min(requestedStepTimeout, Math.floor(remainingMs))),
      );

      let receipt: ActionReceipt;
      try {
        receipt = await this.executeStep(envelope);
      } catch {
        return stoppedReceipt({
          sequence,
          startedAt,
          risk,
          stepReceipts,
          completedSteps,
          stoppedAtStep: step.stepId,
          skippedSteps: steps.slice(index + 1).map((item) => item.stepId),
          error: sequenceError('STEP_FAILED', `Step ${step.stepId} raised an execution error.`, step.stepId),
          now: this.now,
        });
      }

      stepReceipts.push(receipt);
      const stepCompleted = receipt.status === 'completed' && receipt.verification.status !== 'failed';
      if (stepCompleted) completedSteps += 1;

      try {
        await this.onStepReceipt?.(receipt);
      } catch {
        return stoppedReceipt({
          sequence,
          startedAt,
          risk,
          stepReceipts,
          completedSteps,
          stoppedAtStep: step.stepId,
          skippedSteps: steps.slice(index + 1).map((item) => item.stepId),
          error: sequenceError('STEP_FAILED', `Step ${step.stepId} receipt could not be persisted.`, step.stepId),
          now: this.now,
        });
      }

      if (!stepCompleted) {
        const blocked = receipt.status === 'blocked';
        return stoppedReceipt({
          sequence,
          startedAt,
          risk,
          stepReceipts,
          completedSteps,
          stoppedAtStep: step.stepId,
          skippedSteps: steps.slice(index + 1).map((item) => item.stepId),
          error: sequenceError(
            blocked ? 'STEP_BLOCKED' : 'STEP_FAILED',
            blocked
              ? `Step ${step.stepId} was blocked and the sequence stopped.`
              : `Step ${step.stepId} failed and the sequence stopped.`,
            step.stepId,
          ),
          now: this.now,
        });
      }
    }

    return {
      protocolVersion: COMPUTER_PROTOCOL_VERSION,
      sequenceId: sequence.sequenceId,
      startedAt,
      finishedAt: toIso(this.now()),
      status: 'completed',
      risk,
      totalSteps: steps.length,
      completedSteps,
      stepReceipts,
    };
  }
}

export function validateActionSequence(
  sequence: ComputerActionSequence,
  defaultStepTimeoutMs = 30_000,
): SequenceError[] {
  const errors: SequenceError[] = [];
  if (!isPlainObject(sequence)) {
    return [sequenceError('SEQUENCE_INVALID', 'Sequence must be an object.')];
  }

  const unknownSequenceFields = Object.keys(sequence).filter((key) => !['sequenceId', 'steps', 'stopOnFailure', 'timeoutMs'].includes(key));
  if (unknownSequenceFields.length > 0) {
    errors.push(sequenceError('SEQUENCE_INVALID', `Sequence contains unsupported fields: ${unknownSequenceFields.sort().join(', ')}.`));
  }
  if (typeof sequence.sequenceId !== 'string' || !SEQUENCE_ID_PATTERN.test(sequence.sequenceId)) {
    errors.push(sequenceError('SEQUENCE_INVALID', 'sequenceId must use 1-64 letters, digits, dots, underscores, or hyphens and begin with a letter or digit.'));
  }
  if (!Array.isArray(sequence.steps) || sequence.steps.length === 0) {
    errors.push(sequenceError('SEQUENCE_INVALID', 'steps must contain at least one action step.'));
    return errors;
  }
  if (sequence.steps.length > MAX_SEQUENCE_STEPS) {
    errors.push(sequenceError('SEQUENCE_TOO_LARGE', `steps may contain at most ${MAX_SEQUENCE_STEPS} action steps.`));
  }
  if (sequence.stopOnFailure !== undefined && sequence.stopOnFailure !== true) {
    errors.push(sequenceError('STOP_ON_FAILURE_REQUIRED', 'stopOnFailure may be omitted or set to true; false is forbidden.'));
  }
  if (sequence.timeoutMs !== undefined && (!Number.isInteger(sequence.timeoutMs) || sequence.timeoutMs < 1 || sequence.timeoutMs > MAX_SEQUENCE_TIMEOUT_MS)) {
    errors.push(sequenceError('SEQUENCE_INVALID', `Sequence timeoutMs must be between 1 and ${MAX_SEQUENCE_TIMEOUT_MS}.`));
  }

  const seen = new Set<string>();
  for (let index = 0; index < sequence.steps.length; index += 1) {
    const step = sequence.steps[index] as ComputerActionStep;
    if (!isPlainObject(step)) {
      errors.push(sequenceError('SEQUENCE_INVALID', `Step at index ${index} must be an object.`));
      continue;
    }
    const stepId = typeof step.stepId === 'string' ? step.stepId : undefined;
    const unknownStepFields = Object.keys(step).filter((key) => !['stepId', 'action', 'reason', 'expectedPostcondition', 'risk', 'timeoutMs', 'approved'].includes(key));
    if (unknownStepFields.length > 0) {
      errors.push(sequenceError('SEQUENCE_INVALID', `Step ${stepId ?? index} contains unsupported fields: ${unknownStepFields.sort().join(', ')}.`, stepId));
    }
    if (!stepId || !STEP_ID_PATTERN.test(stepId)) {
      errors.push(sequenceError('SEQUENCE_INVALID', `Step at index ${index} has an invalid stepId.`, stepId));
      continue;
    }
    if (seen.has(stepId)) {
      errors.push(sequenceError('DUPLICATE_STEP_ID', `stepId ${stepId} is duplicated.`, stepId));
      continue;
    }
    seen.add(stepId);

    if (!isPlainObject(step.action) || typeof step.action.type !== 'string') {
      errors.push(sequenceError('SEQUENCE_INVALID', `Step ${stepId} requires a Computer Action object.`, stepId));
      continue;
    }
    if (nestedActionTypes.has(step.action.type)) {
      errors.push(sequenceError('NESTED_SEQUENCE_FORBIDDEN', `Step ${stepId} attempts to nest a sequence.`, stepId));
      continue;
    }
    if (!allowedActionTypes.has(step.action.type)) {
      errors.push(sequenceError('SEQUENCE_INVALID', `Step ${stepId} action ${step.action.type} is not supported in bounded sequences.`, stepId));
      continue;
    }
    if (typeof step.reason !== 'string' || step.reason.trim().length === 0) {
      errors.push(sequenceError('SEQUENCE_INVALID', `Step ${stepId} requires a reason.`, stepId));
      continue;
    }
    if (!isPlainObject(step.expectedPostcondition)) {
      errors.push(sequenceError('SEQUENCE_INVALID', `Step ${stepId} requires an expectedPostcondition.`, stepId));
      continue;
    }
    if (!isRiskLevel(step.risk)) {
      errors.push(sequenceError('SEQUENCE_INVALID', `Step ${stepId} has an invalid risk.`, stepId));
      continue;
    }
    if (step.timeoutMs !== undefined && (!Number.isInteger(step.timeoutMs) || step.timeoutMs < 1 || step.timeoutMs > 120_000)) {
      errors.push(sequenceError('SEQUENCE_INVALID', `Step ${stepId} timeoutMs must be between 1 and 120000.`, stepId));
      continue;
    }
    if (step.approved !== undefined && typeof step.approved !== 'boolean') {
      errors.push(sequenceError('SEQUENCE_INVALID', `Step ${stepId} approved must be a boolean.`, stepId));
      continue;
    }

    const actionErrors = validateActionEnvelope(toActionEnvelope(
      sequence.sequenceId,
      step,
      step.timeoutMs ?? clampStepTimeout(defaultStepTimeoutMs),
    ));
    if (actionErrors.length > 0) {
      errors.push(sequenceError('STEP_BLOCKED', `Step ${stepId} violates the single-action contract: ${actionErrors.join('; ')}`, stepId));
    }
  }
  return errors;
}

export function sequenceActionId(sequenceId: string, stepId: string): string {
  return `${sequenceId}:${stepId}`;
}

function toActionEnvelope(sequenceId: string, step: ComputerActionStep, timeoutMs: number): ActionEnvelope {
  return {
    actionId: sequenceActionId(sequenceId, step.stepId),
    action: step.action,
    reason: step.reason,
    expectedPostcondition: step.expectedPostcondition,
    risk: step.risk,
    timeoutMs,
    ...(step.approved === undefined ? {} : { approved: step.approved }),
  };
}

function resolveTotalTimeout(sequence: ComputerActionSequence, defaultStepTimeoutMs: number): number {
  if (sequence.timeoutMs !== undefined) return sequence.timeoutMs;
  const requested = sequence.steps.reduce((total, step) => total + (step.timeoutMs ?? defaultStepTimeoutMs), 0);
  return Math.max(1, Math.min(requested, MAX_SEQUENCE_TIMEOUT_MS));
}

function stoppedReceipt(input: {
  sequence: ComputerActionSequence;
  startedAt: string;
  risk: RiskLevel;
  stepReceipts: ActionReceipt[];
  completedSteps: number;
  stoppedAtStep: string;
  skippedSteps: string[];
  error: SequenceError;
  now: () => number;
}): SequenceReceipt {
  const firstReceipt = input.stepReceipts.length === 1 ? input.stepReceipts[0] : undefined;
  const status: SequenceReceipt['status'] = input.completedSteps > 0
    ? 'partially-completed'
    : firstReceipt?.status === 'blocked' || input.error.code === 'STEP_BLOCKED'
      ? 'blocked'
      : 'failed';
  return {
    protocolVersion: COMPUTER_PROTOCOL_VERSION,
    sequenceId: input.sequence.sequenceId,
    startedAt: input.startedAt,
    finishedAt: toIso(input.now()),
    status,
    risk: input.risk,
    totalSteps: input.sequence.steps.length,
    completedSteps: input.completedSteps,
    stoppedAtStep: input.stoppedAtStep,
    ...(input.skippedSteps.length > 0 ? { skippedSteps: input.skippedSteps } : {}),
    stepReceipts: input.stepReceipts,
    error: input.error,
  };
}

function combineValidationErrors(errors: SequenceError[]): SequenceError {
  const primary = errors[0]!;
  if (errors.length === 1) return primary;
  return {
    ...primary,
    message: `${primary.message} ${errors.length - 1} additional sequence validation error(s) were found.`,
  };
}

function sequenceError(code: SequenceError['code'], message: string, stepId?: string): SequenceError {
  return {
    code,
    message,
    retryable: false,
    ...(stepId ? { stepId } : {}),
  };
}

function highestRisk(steps: ComputerActionStep[]): RiskLevel {
  let highest: RiskLevel = 'read';
  for (const step of steps) {
    if (isRiskLevel(step?.risk) && riskRank[step.risk] > riskRank[highest]) highest = step.risk;
  }
  return highest;
}

function validStepIds(steps: ComputerActionStep[]): string[] {
  return steps.flatMap((step) => typeof step?.stepId === 'string' ? [step.stepId] : []);
}

function isRiskLevel(value: unknown): value is RiskLevel {
  return value === 'read' || value === 'reversible-write' || value === 'external-write' || value === 'destructive';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampStepTimeout(value: number): number {
  if (!Number.isFinite(value)) return 30_000;
  return Math.max(1, Math.min(Math.trunc(value), 120_000));
}

function toIso(value: number): string {
  return new Date(value).toISOString();
}
