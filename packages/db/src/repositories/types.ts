import {
  JsonValueSchema,
  canonicalJsonV1,
  canonicalSha256V1,
  type JsonObject,
  type JsonValue,
} from '@ww/shared';

export type UInt64String = string;

export interface VersionedRow {
  readonly version: UInt64String;
}

export class RepositoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepositoryConflictError';
  }
}

export class RepositoryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepositoryNotFoundError';
  }
}

export class RepositoryWriteError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'RepositoryWriteError';
    this.cause = cause;
  }
}

export interface UncertainWriteCause {
  readonly insert: unknown;
  readonly reconciliation?: unknown;
}

export interface AcknowledgedWriteVerificationCause {
  readonly commitLikely: true;
  readonly operationIdentity: string;
  readonly verification: unknown;
}

export class EmptyAcknowledgedWriteVerificationError extends Error {
  constructor(entity: string) {
    super(`${entity} dogrulama okumasi bos sonuc dondurdu`);
    this.name = 'EmptyAcknowledgedWriteVerificationError';
  }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function uncertainWriteError(
  entity: string,
  insert: unknown,
  reconciliation?: unknown,
): RepositoryWriteError {
  const cause: UncertainWriteCause = reconciliation === undefined
    ? Object.freeze({ insert })
    : Object.freeze({ insert, reconciliation });
  const reconciliationDetail = reconciliation === undefined
    ? ''
    : `; uzlastirma okuması basarisiz: ${errorDetail(reconciliation)}`;
  return new RepositoryWriteError(
    `${entity} insert sonucu belirsiz: ${errorDetail(insert)}${reconciliationDetail}`,
    cause,
  );
}

export async function readAfterUncertainWrite<T>(
  entity: string,
  insert: unknown,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (reconciliation) {
    throw uncertainWriteError(entity, insert, reconciliation);
  }
}

export function acknowledgedWriteVerificationError(
  entity: string,
  operation: unknown,
  verification: unknown,
): RepositoryWriteError {
  const operationIdentity = canonicalSha256V1({ entity, operation });
  const cause: AcknowledgedWriteVerificationCause = Object.freeze({
    commitLikely: true,
    operationIdentity,
    verification,
  });
  return new RepositoryWriteError(
    `${entity} insert onaylandi ancak yazim dogrulanamadi: ${errorDetail(verification)}`,
    cause,
  );
}

/**
 * Protect only the read performed after ClickHouse acknowledged an insert.
 * Reconciliation and domain validation must remain outside this callback so
 * conflicts and not-found results preserve their repository taxonomy.
 */
export async function readAfterAcknowledgedWrite<T>(
  entity: string,
  operation: unknown,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (verification) {
    if (
      verification instanceof RepositoryConflictError ||
      verification instanceof RepositoryNotFoundError
    ) throw verification;
    throw acknowledgedWriteVerificationError(entity, operation, verification);
  }
}

export async function readRowsAfterAcknowledgedWrite<T>(
  entity: string,
  operation: unknown,
  read: () => Promise<T[]>,
): Promise<T[]> {
  const rows = await readAfterAcknowledgedWrite(entity, operation, read);
  if (rows.length === 0) {
    throw acknowledgedWriteVerificationError(
      entity,
      operation,
      new EmptyAcknowledgedWriteVerificationError(entity),
    );
  }
  return rows;
}

export class StoredRecordError extends Error {
  readonly cause: unknown;

  constructor(context: string, cause: unknown) {
    super(`gecersiz kalici kayit: ${context}`);
    this.name = 'StoredRecordError';
    this.cause = cause;
  }
}

function fail(context: string, value: unknown): never {
  throw new StoredRecordError(context, value);
}

export function storedRecord(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail(context, value);
  }
  return value as Record<string, unknown>;
}

export function storedString(value: unknown, context: string): string {
  return typeof value === 'string' ? value : fail(context, value);
}

export function storedDateTime(value: unknown, context: string): string {
  const text = storedString(value, context);
  const utcText = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)
    ? `${text.replace(' ', 'T')}Z`
    : text;
  const milliseconds = Date.parse(utcText);
  if (!Number.isFinite(milliseconds)) return fail(context, value);
  return new Date(milliseconds).toISOString();
}

export function storedFiniteNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fail(context, value);
  return value;
}

export function storedNonnegativeFiniteNumber(value: unknown, context: string): number {
  const parsed = storedFiniteNumber(value, context);
  return parsed >= 0 ? parsed : fail(context, value);
}

export function storedUnsignedInteger(
  value: unknown,
  context: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (
    typeof parsed !== 'number' ||
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    parsed > maximum
  ) return fail(context, value);
  return parsed;
}

export function storedUInt64(value: unknown, context: string): UInt64String {
  const text = typeof value === 'number' && Number.isSafeInteger(value)
    ? String(value)
    : value;
  if (typeof text !== 'string' || !/^\d+$/.test(text)) return fail(context, value);
  try {
    const parsed = BigInt(text);
    if (parsed < 0n || parsed > 18_446_744_073_709_551_615n) return fail(context, value);
    return parsed.toString();
  } catch (error) {
    throw new StoredRecordError(context, error);
  }
}

export function storedStringArray(value: unknown, context: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    return fail(context, value);
  }
  return Object.freeze([...value]) as readonly string[];
}

export function storedEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  context: string,
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    return fail(context, value);
  }
  return value as T;
}

export function storedJsonObject(value: unknown, context: string): JsonObject {
  const json = storedJsonValue(value, context);
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return fail(context, value);
  }
  return json as JsonObject;
}

export function storedJsonValue(value: unknown, context: string): JsonValue {
  if (typeof value !== 'string') return fail(context, value);
  try {
    const parsed: unknown = JSON.parse(value);
    return JsonValueSchema.parse(parsed);
  } catch (error) {
    throw new StoredRecordError(context, error);
  }
}

export function serializeJsonObject(value: JsonObject, context: string): string {
  return serializeJsonValue(value, context);
}

export function serializeJsonValue(value: JsonValue, context: string): string {
  try {
    return canonicalJsonV1(value);
  } catch (error) {
    throw new StoredRecordError(context, error);
  }
}

/**
 * Deterministic UInt64 successor. Concurrent writers that read the same durable
 * version choose the same next version, making divergent ties observable.
 */
export function nextRepositoryVersion(previous?: UInt64String): UInt64String {
  const prior = previous === undefined ? 0n : BigInt(storedUInt64(previous, 'version'));
  const next = prior + 1n;
  if (next > 18_446_744_073_709_551_615n) {
    throw new RepositoryConflictError('UInt64 repository surum alani tukendi');
  }
  return next.toString();
}

export function assertExpectedVersion(
  entity: string,
  actual: UInt64String,
  expected: UInt64String,
): void {
  const normalized = storedUInt64(expected, `${entity}.expectedVersion`);
  if (actual !== normalized) {
    throw new RepositoryConflictError(
      `${entity} surum catismasi: beklenen=${normalized}, mevcut=${actual}`,
    );
  }
}

/**
 * Reconcile an awaited insert without relying on a unique constraint. Duplicate
 * equal rows are safe retries; a same-key/version row with another hash fails.
 */
export function reconcileVersionedWrite<T extends VersionedRow>(
  entity: string,
  expected: T,
  observed: readonly T[],
): T {
  if (observed.length === 0) {
    throw new RepositoryWriteError(`${entity} yazimi yeniden okunamadi`);
  }

  // GERİ ALINDI (2026-08-31): bu fail-closed kontrol commit'lenmemiş bir
  // değişiklikte SİLİNMİŞTİ; üstündeki yorum ise hâlâ yaptığını söylüyordu.
  // Kontrol olmadan aynı (kimlik, sürüm) çiftinde FARKLI içerik sessizce
  // kabul ediliyor — iyimser eşzamanlılığın tek koruması budur ve beş test
  // (projects, prompts, tasks, types) tam olarak bunu savunuyordu.
  const expectedHash = canonicalSha256V1(expected);
  for (const row of observed) {
    if (canonicalSha256V1(row) !== expectedHash) {
      throw new RepositoryConflictError(
        `${entity} ayni kimlik ve surum icin farkli icerik barindiriyor`,
      );
    }
  }
  return expected;
}
