export const COMMUNICATION_ERROR_CODES = [
  'INVALID_AUTHENTICATION',
  'PRINCIPAL_NOT_FOUND',
  'PRINCIPAL_STOPPED',
  'ROUTE_DENIED',
  'DEADLINE_EXPIRED',
  'STALE_TASK_CONTEXT',
  'ANSWER_MISMATCH',
  'ANSWER_WINNER_PENDING',
  'IDEMPOTENCY_COLLISION',
  'RECIPIENT_SNAPSHOT_INVALID',
  'RECEIPT_SNAPSHOT_INCOMPLETE',
  'RECEIPT_LEASE_UNAVAILABLE',
  'STALE_RECEIPT_FENCE',
  'RETRY_SCHEDULED',
  'RECEIPT_FAILED',
  'EFFECT_FAILED',
  'EFFECT_UNCERTAIN',
  'EFFECT_LEASE_UNAVAILABLE',
  'ESCALATION_UNAVAILABLE',
  'MALFORMED_DUE_ITEM',
  'MODEL_PROVENANCE_INVALID',
] as const;

export type CommunicationErrorCode = (typeof COMMUNICATION_ERROR_CODES)[number];

export class CommunicationError extends Error {
  readonly code: CommunicationErrorCode;
  readonly cause: unknown;

  constructor(code: CommunicationErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'CommunicationError';
    this.code = code;
    this.cause = cause;
  }
}

export class CommunicationPolicyError extends CommunicationError {
  readonly ruleId: string;

  constructor(code: CommunicationErrorCode, ruleId: string, message: string) {
    super(code, message);
    this.name = 'CommunicationPolicyError';
    this.ruleId = ruleId;
  }
}

export type EffectFailureOutcome = 'definite_failure' | 'uncertain';

export class DurableEffectExecutionError extends Error {
  readonly outcome: EffectFailureOutcome;
  readonly cause: unknown;

  constructor(outcome: EffectFailureOutcome, message: string, cause?: unknown) {
    super(message);
    this.name = 'DurableEffectExecutionError';
    this.outcome = outcome;
    this.cause = cause;
  }
}

export interface PersistedErrorV1 {
  readonly code: string;
  readonly summary: string;
  readonly serialized: string;
}

const COMMUNICATION_ERROR_SUMMARIES: Readonly<Record<CommunicationErrorCode, string>> = {
  INVALID_AUTHENTICATION: 'kimlik dogrulamasi reddedildi',
  PRINCIPAL_NOT_FOUND: 'principal kaydi bulunamadi',
  PRINCIPAL_STOPPED: 'principal durdurulmus',
  ROUTE_DENIED: 'iletisim rotasi reddedildi',
  DEADLINE_EXPIRED: 'mesaj son tarihi gecmis',
  STALE_TASK_CONTEXT: 'gorev baglami stale',
  ANSWER_MISMATCH: 'cevap hedef soruyla eslesmiyor',
  ANSWER_WINNER_PENDING: 'authoritative cevap secimi henuz tamamlanmadi',
  IDEMPOTENCY_COLLISION: 'idempotency niyeti catisti',
  RECIPIENT_SNAPSHOT_INVALID: 'alici snapshoti gecersiz',
  RECEIPT_SNAPSHOT_INCOMPLETE: 'alici receipt snapshoti eksik',
  RECEIPT_LEASE_UNAVAILABLE: 'receipt lease alinamadi',
  STALE_RECEIPT_FENCE: 'receipt fence stale',
  RETRY_SCHEDULED: 'receipt yeniden denemeye alindi',
  RECEIPT_FAILED: 'receipt kalici olarak basarisiz',
  EFFECT_FAILED: 'kalici effect basarisiz',
  EFFECT_UNCERTAIN: 'kalici effect sonucu belirsiz',
  EFFECT_LEASE_UNAVAILABLE: 'effect lease alinamadi',
  ESCALATION_UNAVAILABLE: 'typed escalation teslim edilemedi',
  MALFORMED_DUE_ITEM: 'kalici inbox adayi gecersiz',
  MODEL_PROVENANCE_INVALID: 'gercek model provenance kaydi gecersiz',
};

/** Persisted/observable errors never include provider, token, prompt, or exception text. */
export function sanitizePersistedError(error: unknown): PersistedErrorV1 {
  let code = 'INTERNAL_ERROR';
  let summary = 'beklenmeyen iletisim hatasi';
  if (error instanceof CommunicationError) {
    code = error.code;
    summary = COMMUNICATION_ERROR_SUMMARIES[error.code];
  } else if (error instanceof DurableEffectExecutionError) {
    code = error.outcome === 'uncertain'
      ? 'EXTERNAL_EFFECT_UNCERTAIN'
      : 'EXTERNAL_EFFECT_FAILED';
    summary = error.outcome === 'uncertain'
      ? 'dis effect sonucu dogrulanamadi'
      : 'dis effect kesin olarak basarisiz';
  } else if (error instanceof Error && error.name === 'RepositoryConflictError') {
    code = 'DURABLE_CONFLICT';
    summary = 'kalici kayit catismasi';
  } else if (error instanceof Error && error.name === 'RepositoryWriteError') {
    code = 'DURABLE_WRITE_UNCERTAIN';
    summary = 'kalici yazim sonucu dogrulanamadi';
  } else if (error instanceof Error && error.name === 'StoredRecordError') {
    code = 'MALFORMED_STORED_RECORD';
    summary = 'kalici kayit dogrulamasi basarisiz';
  }
  return Object.freeze({ code, summary, serialized: `${code}: ${summary}` });
}
