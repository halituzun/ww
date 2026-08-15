export const EXECUTOR_ERROR_CODES = [
  'INVALID_TOOL',
  'INVALID_ARGUMENTS',
  'CAPABILITY_DENIED',
  'LEASE_REQUIRED',
  'LOCK_REQUIRED',
  'PATH_INVALID',
  'PATH_ESCAPE',
  'TARGET_NOT_DECLARED',
  'FILE_NOT_FOUND',
  'EDIT_MISMATCH',
  'COMMAND_NOT_ALLOWED',
  'COMMAND_UNAVAILABLE',
  'COMMAND_TIMEOUT',
  'COMMAND_CONCURRENCY_LIMIT',
  'SANDBOX_UNAVAILABLE',
  'SANDBOX_CLEANUP_FAILED',
  'SANDBOX_INPUT_TOO_LARGE',
  'SANDBOX_SCOPE_VIOLATION',
  'SANDBOX_ABORTED',
  'SANDBOX_TIMEOUT',
  'SANDBOX_INVALID_ARGUMENT',
  'EFFECT_OUTCOME_UNKNOWN',
  'FENCE_LOST',
  'AUDIT_FAILED',
  'CALL_INTENT_CONFLICT',
  'FILE_CONFLICT',
  'SANDBOX_RESULT_INVALID',
  'GATE_CONFIG_INVALID',
  'GATE_FAILED',
  'GIT_FAILED',
  'GIT_CONFLICT',
  'WORKSPACE_NOT_EMPTY',
  'STARTER_PUBLISH_FAILED',
  'INSTALL_FAILED',
] as const;

export type ExecutorErrorCode = (typeof EXECUTOR_ERROR_CODES)[number];

export class ExecutorError extends Error {
  constructor(
    readonly code: ExecutorErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = Object.freeze({}),
  ) {
    super(message);
    this.name = 'ExecutorError';
  }
}
