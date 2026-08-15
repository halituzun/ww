import type { PolicyDecision } from '@ww/shared';
import {
  RepositoryConflictError,
  RepositoryNotFoundError,
  RepositoryWriteError,
  StoredRecordError,
} from '@ww/db';

export type SchedulerErrorCode =
  | 'TASK_NOT_FOUND'
  | 'DEPENDENCY_BLOCKED'
  | 'LEASE_UNAVAILABLE'
  | 'STALE_FENCE'
  | 'FILE_LOCK_UNAVAILABLE'
  | 'NO_ELIGIBLE_AGENT'
  | 'POLICY_DENIED'
  | 'INTEGRITY_CONFLICT'
  | 'UNCERTAIN_WRITE';

export class SchedulerError extends Error {
  readonly code: SchedulerErrorCode;
  readonly cause: unknown;

  constructor(code: SchedulerErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'SchedulerError';
    this.code = code;
    this.cause = cause;
  }
}

export class TaskDeferredError extends SchedulerError {
  constructor(
    code: Extract<SchedulerErrorCode,
      'DEPENDENCY_BLOCKED' | 'LEASE_UNAVAILABLE' | 'FILE_LOCK_UNAVAILABLE' |
      'NO_ELIGIBLE_AGENT'>,
    message: string,
  ) {
    super(code, message);
    this.name = 'TaskDeferredError';
  }
}

export class TaskPolicyDeniedError extends SchedulerError {
  readonly decision: PolicyDecision;

  constructor(decision: PolicyDecision) {
    super('POLICY_DENIED', decision.reason);
    this.name = 'TaskPolicyDeniedError';
    this.decision = decision;
  }
}

export function schedulerBoundaryError(
  error: unknown,
  context: string,
  notFoundCode: Extract<SchedulerErrorCode, 'TASK_NOT_FOUND' | 'INTEGRITY_CONFLICT'> =
    'INTEGRITY_CONFLICT',
): unknown {
  if (error instanceof SchedulerError) return error;
  if (error instanceof RepositoryWriteError) {
    return new SchedulerError(
      'UNCERTAIN_WRITE',
      `${context} durable yazisi uzlastirilamadi: ${error.message}`,
      error,
    );
  }
  if (error instanceof RepositoryNotFoundError) {
    return new SchedulerError(notFoundCode, `${context}: ${error.message}`, error);
  }
  if (error instanceof RepositoryConflictError || error instanceof StoredRecordError) {
    return new SchedulerError('INTEGRITY_CONFLICT', `${context}: ${error.message}`, error);
  }
  return error;
}
