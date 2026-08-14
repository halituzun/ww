import {
  EntityIdSchema,
  NIL_UUID,
  type EntityId,
} from '@ww/shared';
import { StoredRecordError } from './types.js';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type StoredUuid = string;
export type StoredOptionalEntityId = EntityId | typeof NIL_UUID;

export function concreteEntityId(value: string, context: string): EntityId {
  const parsed = EntityIdSchema.safeParse(value);
  if (!parsed.success) throw new StoredRecordError(context, parsed.error);
  return parsed.data;
}

/** ClickHouse UUIDs may contain Phase 0 nil/sentinel defaults on legacy rows. */
export function storedUuid(value: unknown, context: string): StoredUuid {
  if (typeof value !== 'string' || !UUID_SHAPE.test(value)) {
    throw new StoredRecordError(context, value);
  }
  return value.toLowerCase();
}

export function optionalEntityId(value: string, context: string): StoredOptionalEntityId {
  if (value.toLowerCase() === NIL_UUID) return NIL_UUID;
  return concreteEntityId(value, context);
}

export function storedEntityIdArray(value: unknown, context: string): readonly EntityId[] {
  if (!Array.isArray(value)) throw new StoredRecordError(context, value);
  return Object.freeze(value.map((item, index) => concreteEntityId(
    storedUuid(item, `${context}[${index}]`),
    `${context}[${index}]`,
  )));
}
