// Rol -> model eşlemesi (docs/04 → Rol→Model Eşleme, docs/08 → API Yönetimi).
// Tablo 0001_init'ten beri şemadaydı ama hiçbir kod ona dokunmuyordu.
import type { ClickHouseClient } from '@clickhouse/client';
import { AGENT_ROLES } from '@ww/shared';
import {
  nextRepositoryVersion,
  readAfterUncertainWrite,
  storedDateTime,
  storedRecord,
  storedString,
  storedStringArray,
  storedUInt64,
  uncertainWriteError,
  type UInt64String,
} from './types.js';

export interface RoleModelRow {
  readonly role: string;
  readonly model_ref: string;
  readonly fallback_refs: readonly string[];
  readonly updated_at: string;
  readonly version: UInt64String;
}

export type UpsertRoleModelInput = Omit<RoleModelRow, 'version'>;

const COLUMNS = 'role,model_ref,fallback_refs,updated_at,version';

// docs/04: model_ref daima 'provider:model' biçimindedir.
const MODEL_REF = /^[a-z0-9_-]+:[A-Za-z0-9._:-]+$/;

function assertRole(role: string): string {
  const value = role.trim();
  if (!(AGENT_ROLES as readonly string[]).includes(value)) {
    throw new Error(`gecersiz rol: ${role}`);
  }
  return value;
}

function assertModelRef(value: string, field: string): string {
  const ref = value.trim();
  if (!MODEL_REF.test(ref)) throw new Error(`gecersiz ${field}: ${value}`);
  return ref;
}

function parse(value: unknown): RoleModelRow {
  const row = storedRecord(value, 'role_models');
  return Object.freeze({
    role: storedString(row['role'], 'role_models.role'),
    model_ref: storedString(row['model_ref'], 'role_models.model_ref'),
    fallback_refs: storedStringArray(row['fallback_refs'], 'role_models.fallback_refs'),
    updated_at: storedDateTime(row['updated_at'], 'role_models.updated_at'),
    version: storedUInt64(row['version'], 'role_models.version'),
  });
}

async function readRows(ch: ClickHouseClient, role?: string): Promise<RoleModelRow[]> {
  const where = role === undefined ? '' : ' WHERE role = {role:String}';
  const result = await ch.query({
    query: `SELECT ${COLUMNS} FROM role_models${where} ORDER BY role ASC, version DESC`,
    query_params: role === undefined ? {} : { role },
    format: 'JSONEachRow',
  });
  return (await result.json<unknown>()).map(parse);
}

function sameContent(left: RoleModelRow, right: UpsertRoleModelInput): boolean {
  return left.role === right.role
    && left.model_ref === right.model_ref
    && JSON.stringify(left.fallback_refs) === JSON.stringify(right.fallback_refs)
    && left.updated_at === right.updated_at;
}

export async function listLatestRoleModels(ch: ClickHouseClient): Promise<readonly RoleModelRow[]> {
  const result = await ch.query({
    query: `SELECT ${COLUMNS} FROM role_models
      WHERE (role, version) IN (SELECT role, max(version) FROM role_models GROUP BY role)
      ORDER BY role ASC`,
    query_params: {},
    format: 'JSONEachRow',
  });
  return (await result.json<unknown>()).map(parse);
}

export async function getLatestRoleModel(ch: ClickHouseClient, role: string): Promise<RoleModelRow | null> {
  const value = role.trim();
  if (value.length === 0 || value.length > 64) throw new Error('gecersiz rol');
  return (await readRows(ch, value))[0] ?? null;
}

export async function upsertRoleModel(
  ch: ClickHouseClient,
  input: UpsertRoleModelInput,
): Promise<RoleModelRow> {
  const role = assertRole(input.role);
  const normalized: UpsertRoleModelInput = {
    role,
    model_ref: assertModelRef(input.model_ref, 'model_ref'),
    fallback_refs: input.fallback_refs.map((ref) => assertModelRef(ref, 'fallback_refs')),
    updated_at: input.updated_at,
  };

  const current = await getLatestRoleModel(ch, role);
  if (current !== null && sameContent(current, normalized)) return current;

  const row: RoleModelRow = Object.freeze({
    ...normalized,
    version: nextRepositoryVersion(current?.version),
  });
  try {
    await ch.insert({ table: 'role_models', values: [row], format: 'JSONEachRow' });
  } catch (error) {
    const observed = await readAfterUncertainWrite(`role-model:${role}`, error, () => readRows(ch, role));
    if (observed.length > 0) return observed[0]!;
    throw uncertainWriteError(`role-model:${role}`, error);
  }
  return row;
}
