import type { ClickHouseClient } from '@clickhouse/client';
import {
  EVENT_TYPES,
  canonicalSha256V1,
  type EntityId,
  type EventType,
  type JsonValue,
} from '@ww/shared';
import { concreteEntityId, optionalEntityId, storedUuid, type StoredOptionalEntityId } from './identifiers.js';
import {
  RepositoryConflictError,
  RepositoryWriteError,
  readRowsAfterAcknowledgedWrite,
  readAfterUncertainWrite,
  serializeJsonValue,
  storedDateTime,
  storedEnum,
  storedJsonValue,
  storedRecord,
  storedString,
  storedUInt64,
  storedUnsignedInteger,
  uncertainWriteError,
  type UInt64String,
} from './types.js';

export interface EventRow {
  readonly event_id: EntityId;
  readonly seq: UInt64String;
  readonly project_id: EntityId;
  readonly task_id: StoredOptionalEntityId;
  readonly agent_id: StoredOptionalEntityId;
  readonly event_type: EventType;
  readonly tool_name: string;
  readonly payload: JsonValue;
  readonly duration_ms: number;
  readonly created_at: string;
}

export type AppendEventInput = EventRow;

const EVENT_COLUMNS = `event_id, seq, project_id, task_id, agent_id, event_type,
  tool_name, payload, duration_ms, created_at`;

function parseEvent(value: unknown): EventRow {
  const row = storedRecord(value, 'events');
  return Object.freeze({
    event_id: concreteEntityId(storedUuid(row['event_id'], 'events.event_id'), 'events.event_id'),
    seq: storedUInt64(row['seq'], 'events.seq'),
    project_id: concreteEntityId(storedUuid(row['project_id'], 'events.project_id'), 'events.project_id'),
    task_id: optionalEntityId(storedUuid(row['task_id'], 'events.task_id'), 'events.task_id'),
    agent_id: optionalEntityId(storedUuid(row['agent_id'], 'events.agent_id'), 'events.agent_id'),
    event_type: storedEnum(row['event_type'], EVENT_TYPES, 'events.event_type'),
    tool_name: storedString(row['tool_name'], 'events.tool_name'),
    payload: storedJsonValue(row['payload'], 'events.payload'),
    duration_ms: storedUnsignedInteger(row['duration_ms'], 'events.duration_ms', 4_294_967_295),
    created_at: storedDateTime(row['created_at'], 'events.created_at'),
  });
}

function normalizeEvent(input: AppendEventInput): EventRow {
  return parseEvent({ ...input, payload: serializeJsonValue(input.payload, 'events.payload') });
}

function toInsertRow(row: EventRow): Record<string, unknown> {
  return { ...row, payload: serializeJsonValue(row.payload, 'events.payload') };
}

async function readEventRows(ch: ClickHouseClient, eventId: EntityId): Promise<EventRow[]> {
  const result = await ch.query({
    query: `SELECT ${EVENT_COLUMNS} FROM events WHERE event_id = {eventId:UUID}`,
    query_params: { eventId },
    format: 'JSONEachRow',
  });
  return (await result.json<unknown>()).map(parseEvent);
}

function reconcileEvent(expected: EventRow, rows: readonly EventRow[]): EventRow {
  if (rows.length === 0) throw new RepositoryWriteError(`event:${expected.event_id} yazimi yeniden okunamadi`);
  const hash = canonicalSha256V1(expected);
  if (rows.some((row) => canonicalSha256V1(row) !== hash)) {
    throw new RepositoryConflictError(`event:${expected.event_id} immutable kimlik/hash catismasi`);
  }
  return rows[0]!;
}

export async function getEvent(ch: ClickHouseClient, eventId: string): Promise<EventRow | null> {
  const id = concreteEntityId(eventId, 'eventId');
  const rows = await readEventRows(ch, id);
  return rows.length === 0 ? null : reconcileEvent(rows[0]!, rows);
}

export async function listEvents(
  ch: ClickHouseClient,
  projectId: string,
  options: { readonly limit?: number; readonly afterSeq?: bigint } = {},
): Promise<EventRow[]> {
  const project = concreteEntityId(projectId, 'projectId');
  const limit = storedUnsignedInteger(options.limit ?? 100, 'events.limit', 1_000);

  // İmleç ZORUNLU: imleçsiz sorgu en ESKİ `limit` olayı döndürür. Canlı besleme
  // bunları imleçle süzdüğü için, proje `limit` olayı geçtiğinde akış kalıcı
  // olarak susuyordu (panel bağlı görünüp donuyordu).
  const afterSeq = options.afterSeq;
  const seqFilter = afterSeq === undefined ? '' : ' AND seq > {afterSeq:UInt64}';
  const params: Record<string, string | number> = { projectId: project, limit };
  if (afterSeq !== undefined) params['afterSeq'] = afterSeq.toString();

  const result = await ch.query({
    query: `SELECT ${EVENT_COLUMNS} FROM events
      WHERE project_id = {projectId:UUID}${seqFilter}
        AND event_id IN (
          SELECT event_id FROM events
          WHERE project_id = {projectId:UUID}${seqFilter}
          GROUP BY event_id
          ORDER BY min(created_at) ASC, min(seq) ASC, event_id ASC
          LIMIT {limit:UInt32}
        )
      ORDER BY created_at ASC, seq ASC, event_id ASC`,
    query_params: params,
    format: 'JSONEachRow',
  });
  const physical = (await result.json<unknown>()).map(parseEvent);
  const logical = new Map<string, EventRow>();
  for (const row of physical) {
    const prior = logical.get(row.event_id);
    logical.set(row.event_id, prior === undefined ? row : reconcileEvent(row, [prior]));
  }
  return [...logical.values()].slice(0, limit);
}

export async function appendEvent(ch: ClickHouseClient, input: AppendEventInput): Promise<EventRow> {
  const event = normalizeEvent(input);
  const prior = await readEventRows(ch, event.event_id);
  if (prior.length > 0) return reconcileEvent(event, prior);
  try {
    await ch.insert({ table: 'events', values: [toInsertRow(event)], format: 'JSONEachRow' });
  } catch (error) {
    const entity = `event:${event.event_id}`;
    const observed = await readAfterUncertainWrite(
      entity,
      error,
      () => readEventRows(ch, event.event_id),
    );
    if (observed.length > 0) return reconcileEvent(event, observed);
    throw uncertainWriteError(entity, error);
  }
  const observed = await readRowsAfterAcknowledgedWrite(
    `event:${event.event_id}`,
    event,
    () => readEventRows(ch, event.event_id),
  );
  return reconcileEvent(event, observed);
}
