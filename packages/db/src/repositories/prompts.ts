import type { ClickHouseClient } from '@clickhouse/client';
import {
  OpaqueIdentifierSchema,
  VersionedSourceRefV1Schema,
  canonicalSha256V1,
  type VersionedSourceRefV1,
} from '@ww/shared';
import {
  RepositoryConflictError,
  RepositoryNotFoundError,
  StoredRecordError,
  nextRepositoryVersion,
  readRowsAfterAcknowledgedWrite,
  readAfterUncertainWrite,
  reconcileVersionedWrite,
  storedDateTime,
  storedRecord,
  storedString,
  storedStringArray,
  storedUInt64,
  storedUnsignedInteger,
  uncertainWriteError,
  type UInt64String,
} from './types.js';

export interface PromptRow {
  readonly prompt_name: string;
  readonly prompt_version: number;
  readonly content: string;
  readonly variables: readonly string[];
  readonly changelog: string;
  readonly is_active: boolean;
  readonly created_at: string;
  readonly version: UInt64String;
}

export type AppendPromptVersionInput = Omit<PromptRow, 'version'>;

const PROMPT_COLUMNS = `prompt_name, prompt_version, content, variables,
  changelog, is_active, created_at, version, row_hash`;
const ROW_HASH = /^[0-9a-f]{64}$/;

function promptRowHash(row: PromptRow): string {
  return canonicalSha256V1([
    row.prompt_name,
    String(row.prompt_version),
    row.content,
    [...row.variables],
    row.changelog,
    row.is_active ? '1' : '0',
    row.created_at,
    row.version,
  ]);
}

function inputPromptName(value: unknown): string {
  const parsed = OpaqueIdentifierSchema.safeParse(value);
  if (!parsed.success) throw new RepositoryConflictError('gecersiz prompt adi');
  return parsed.data;
}

function storedPromptName(value: unknown): string {
  const parsed = OpaqueIdentifierSchema.safeParse(value);
  if (!parsed.success) throw new StoredRecordError('prompts.prompt_name', parsed.error);
  return parsed.data;
}

function parseActive(value: unknown): boolean {
  const parsed = storedUnsignedInteger(value, 'prompts.is_active', 1);
  return parsed === 1;
}

function parsePrompt(value: unknown): PromptRow {
  const row = storedRecord(value, 'prompts');
  const parsed: PromptRow = Object.freeze({
    prompt_name: storedPromptName(row['prompt_name']),
    prompt_version: storedUnsignedInteger(row['prompt_version'], 'prompts.prompt_version', 4_294_967_295),
    content: storedString(row['content'], 'prompts.content'),
    variables: storedStringArray(row['variables'], 'prompts.variables'),
    changelog: storedString(row['changelog'], 'prompts.changelog'),
    is_active: parseActive(row['is_active']),
    created_at: storedDateTime(row['created_at'], 'prompts.created_at'),
    version: storedUInt64(row['version'], 'prompts.version'),
  });
  if (row['row_hash'] !== undefined) {
    const hash = storedString(row['row_hash'], 'prompts.row_hash');
    if (hash !== '' && (!ROW_HASH.test(hash) || hash !== promptRowHash(parsed))) {
      throw new StoredRecordError('prompts.row_hash integrity', { hash, row: parsed });
    }
  }
  return parsed;
}

function toInsertRow(row: PromptRow): Record<string, unknown> {
  return {
    ...row,
    is_active: row.is_active ? 1 : 0,
    row_hash: promptRowHash(row),
  };
}

function foldPromptVersions(name: string, physical: readonly PromptRow[]): PromptRow[] {
  const grouped = new Map<number, PromptRow[]>();
  for (const row of physical) {
    const rows = grouped.get(row.prompt_version) ?? [];
    rows.push(row);
    grouped.set(row.prompt_version, rows);
  }
  const logical: PromptRow[] = [];
  for (const rows of grouped.values()) {
    const maximum = rows.reduce(
      (latest, row) => BigInt(row.version) > BigInt(latest) ? row.version : latest,
      rows[0]!.version,
    );
    const latest = rows.filter((row) => row.version === maximum);
    logical.push(reconcileVersionedWrite(
      `prompt:${name}@${rows[0]!.prompt_version}`,
      latest[0]!,
      latest,
    ));
  }
  return logical;
}

async function readPromptStateRows(
  ch: ClickHouseClient,
  name: string,
  promptVersion: number,
  version: UInt64String,
): Promise<PromptRow[]> {
  const result = await ch.query({
    query: `SELECT ${PROMPT_COLUMNS} FROM prompts
      WHERE prompt_name = {promptName:String} AND prompt_version = {promptVersion:UInt32}
        AND version = {version:UInt64}`,
    query_params: { promptName: name, promptVersion, version },
    format: 'JSONEachRow',
  });
  return (await result.json<unknown>()).map(parsePrompt);
}

export async function getPromptVersion(
  ch: ClickHouseClient,
  name: string,
  promptVersionValue: number,
): Promise<PromptRow | null> {
  const key = inputPromptName(name);
  const promptVersion = storedUnsignedInteger(promptVersionValue, 'promptVersion', 4_294_967_295);
  const result = await ch.query({
    query: `SELECT ${PROMPT_COLUMNS} FROM prompts
      WHERE prompt_name = {promptName:String} AND prompt_version = {promptVersion:UInt32}
      ORDER BY version DESC`,
    query_params: { promptName: key, promptVersion },
    format: 'JSONEachRow',
  });
  const rows = await result.json<unknown>();
  if (rows.length === 0) return null;
  const parsed = rows.map(parsePrompt);
  const maximum = parsed[0]!.version;
  return reconcileVersionedWrite(
    `prompt:${key}@${promptVersion}`,
    parsed[0]!,
    parsed.filter((row) => row.version === maximum),
  );
}

export async function listPromptVersions(ch: ClickHouseClient, name: string): Promise<PromptRow[]> {
  const key = inputPromptName(name);
  const result = await ch.query({
    query: `SELECT ${PROMPT_COLUMNS} FROM prompts
      WHERE prompt_name = {promptName:String}
      ORDER BY prompt_version ASC, version DESC`,
    query_params: { promptName: key },
    format: 'JSONEachRow',
  });
  const physical = (await result.json<unknown>()).map(parsePrompt);
  return foldPromptVersions(key, physical);
}

export async function getActivePrompt(ch: ClickHouseClient, name: string): Promise<PromptRow | null> {
  const rows = (await listPromptVersions(ch, name)).filter((row) => row.is_active);
  if (rows.length > 1) throw new RepositoryConflictError(`birden cok aktif prompt surumu: ${name}`);
  return rows[0] ?? null;
}

export async function getActivePromptAsOf(
  ch: ClickHouseClient,
  name: string,
  cutoffAt: string,
): Promise<PromptRow | null> {
  const key = inputPromptName(name);
  const cutoff = storedDateTime(cutoffAt, 'cutoffAt').replace('T', ' ').replace('Z', '');
  const result = await ch.query({
    query: `SELECT ${PROMPT_COLUMNS} FROM prompts
      WHERE prompt_name = {promptName:String}
        AND created_at <= {cutoffAt:DateTime64(3, 'UTC')}
      ORDER BY prompt_version ASC, version DESC`,
    query_params: { promptName: key, cutoffAt: cutoff },
    format: 'JSONEachRow',
  });
  const active = foldPromptVersions(
    key,
    (await result.json<unknown>()).map(parsePrompt),
  ).filter((row) => row.is_active);
  if (active.length > 1) {
    throw new RepositoryConflictError(`birden cok aktif as-of prompt surumu: ${key}`);
  }
  return active[0] ?? null;
}

export async function getPromptVersionAsOf(
  ch: ClickHouseClient,
  name: string,
  promptVersionValue: number,
  cutoffAt: string,
): Promise<PromptRow | null> {
  const key = inputPromptName(name);
  const promptVersion = storedUnsignedInteger(promptVersionValue, 'promptVersion', 4_294_967_295);
  const cutoff = storedDateTime(cutoffAt, 'cutoffAt').replace('T', ' ').replace('Z', '');
  const result = await ch.query({
    query: `SELECT ${PROMPT_COLUMNS} FROM prompts
      WHERE prompt_name = {promptName:String} AND prompt_version = {promptVersion:UInt32}
        AND created_at <= {cutoffAt:DateTime64(3, 'UTC')}
      ORDER BY version DESC`,
    query_params: { promptName: key, promptVersion, cutoffAt: cutoff },
    format: 'JSONEachRow',
  });
  const rows = await result.json<unknown>();
  if (rows.length === 0) return null;
  const parsed = rows.map(parsePrompt);
  const maximum = parsed[0]!.version;
  return reconcileVersionedWrite(
    `prompt:${key}@${promptVersion}:asOf`,
    parsed[0]!,
    parsed.filter((row) => row.version === maximum),
  );
}

async function appendPromptState(ch: ClickHouseClient, row: PromptRow): Promise<PromptRow> {
  const entity = `prompt:${row.prompt_name}@${row.prompt_version}`;
  try {
    await ch.insert({ table: 'prompts', values: [toInsertRow(row)], format: 'JSONEachRow' });
  } catch (error) {
    const observed = await readAfterUncertainWrite(
      entity,
      error,
      () => readPromptStateRows(ch, row.prompt_name, row.prompt_version, row.version),
    );
    if (observed.length > 0) return reconcileVersionedWrite(`prompt:${row.prompt_name}@${row.prompt_version}`, row, observed);
    throw uncertainWriteError(entity, error);
  }
  const observed = await readRowsAfterAcknowledgedWrite(
    entity,
    row,
    () => readPromptStateRows(ch, row.prompt_name, row.prompt_version, row.version),
  );
  return reconcileVersionedWrite(entity, row, observed);
}

export async function appendPromptVersion(
  ch: ClickHouseClient,
  input: AppendPromptVersionInput,
): Promise<PromptRow> {
  const name = inputPromptName(input.prompt_name);
  const promptVersion = storedUnsignedInteger(input.prompt_version, 'promptVersion', 4_294_967_295);
  const prior = await getPromptVersion(ch, name, promptVersion);
  if (prior !== null) {
    const candidate = parsePrompt({
      ...input,
      prompt_name: name,
      prompt_version: promptVersion,
      is_active: input.is_active ? 1 : 0,
      version: prior.version,
    });
    if (canonicalSha256V1(candidate) === canonicalSha256V1(prior)) return prior;
    throw new RepositoryConflictError(`prompt surumu icerik catismasi: ${name}@${promptVersion}`);
  }
  return appendPromptState(ch, parsePrompt({
    ...input,
    prompt_name: name,
    prompt_version: promptVersion,
    is_active: input.is_active ? 1 : 0,
    version: nextRepositoryVersion(),
  }));
}

export async function setPromptVersionActive(
  ch: ClickHouseClient,
  name: string,
  promptVersionValue: number,
  active: boolean,
  expectedVersion: UInt64String,
  changedAt: string,
): Promise<PromptRow> {
  const transitionAt = storedDateTime(changedAt, 'changedAt');
  const current = await getPromptVersion(ch, name, promptVersionValue);
  if (current === null) throw new RepositoryNotFoundError(`prompt bulunamadi: ${name}@${promptVersionValue}`);
  const normalizedExpected = storedUInt64(expectedVersion, 'expectedVersion');
  if (current.version !== normalizedExpected) {
    if (
      BigInt(current.version) > BigInt(normalizedExpected) &&
      current.is_active === active &&
      current.created_at === transitionAt
    ) return current;
    throw new RepositoryConflictError(`prompt surum catismasi: ${name}@${promptVersionValue}`);
  }
  if (current.is_active === active) return current;
  if (Date.parse(transitionAt) < Date.parse(current.created_at)) {
    throw new RepositoryConflictError(`prompt gecis zamani geriye gidemez: ${name}@${promptVersionValue}`);
  }
  return appendPromptState(ch, {
    ...current,
    is_active: active,
    created_at: transitionAt,
    version: nextRepositoryVersion(current.version),
  });
}

export async function activatePromptVersion(
  ch: ClickHouseClient,
  name: string,
  promptVersionValue: number,
  changedAt: string,
): Promise<PromptRow> {
  const transitionAt = storedDateTime(changedAt, 'changedAt');
  const versions = await listPromptVersions(ch, name);
  const target = versions.find((row) => row.prompt_version === promptVersionValue);
  if (target === undefined) throw new RepositoryNotFoundError(`prompt bulunamadi: ${name}@${promptVersionValue}`);
  const changing = versions.filter((row) => (
    row.is_active && row.prompt_version !== promptVersionValue
  ) || (row.prompt_version === promptVersionValue && !row.is_active));
  if (changing.some((row) => Date.parse(transitionAt) < Date.parse(row.created_at))) {
    throw new RepositoryConflictError(`prompt aktivasyon zamani geriye gidemez: ${name}`);
  }
  for (const row of versions) {
    if (row.is_active && row.prompt_version !== promptVersionValue) {
      await setPromptVersionActive(
        ch,
        row.prompt_name,
        row.prompt_version,
        false,
        row.version,
        transitionAt,
      );
    }
  }
  const refreshed = await getPromptVersion(ch, name, promptVersionValue);
  if (refreshed === null) throw new RepositoryNotFoundError(`prompt bulunamadi: ${name}@${promptVersionValue}`);
  return setPromptVersionActive(
    ch,
    name,
    promptVersionValue,
    true,
    refreshed.version,
    transitionAt,
  );
}

export async function getPromptSourceRefAsOf(
  ch: ClickHouseClient,
  name: string,
  promptVersion: number,
  cutoffAt: string,
): Promise<VersionedSourceRefV1 | null> {
  const row = await getPromptVersionAsOf(ch, name, promptVersion, cutoffAt);
  if (row === null) return null;
  return VersionedSourceRefV1Schema.parse({
    sourceType: 'prompt',
    sourceId: row.prompt_name,
    version: row.prompt_version,
    hash: canonicalSha256V1(row),
  });
}
