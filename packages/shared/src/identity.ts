import { z } from 'zod';
import {
  BROADCAST_SENTINEL,
  NIL_UUID,
  SYSTEM_SENTINEL,
  USER_SENTINEL,
} from './constants.js';

/** UUID identity for a concrete persisted entity or correlation. */
const RESERVED_ENTITY_IDS = new Set<string>([
  NIL_UUID,
  USER_SENTINEL,
  SYSTEM_SENTINEL,
  BROADCAST_SENTINEL,
]);
const UUID_SHAPED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// RFC UUID denetimi version/variant bitlerini zorunlu kılar. Küçük harfe
// dönüşüm, bu şemayı kullanan bütün çapraz alan eşitliklerini kanonik kılar.
export const EntityIdSchema = z.uuid()
  .transform((value) => value.toLowerCase())
  .refine(
    (value) => !RESERVED_ENTITY_IDS.has(value),
    'somut varlık kimliği nil veya ayrılmış sentinel UUID olamaz',
  );

export type EntityId = z.infer<typeof EntityIdSchema>;

/** Case-sensitive opaque identifier or canonical concrete UUID. */
export const OpaqueIdentifierSchema = z.string().trim().min(1).transform((value, ctx) => {
  const lowercase = value.toLowerCase();
  if (RESERVED_ENTITY_IDS.has(lowercase)) {
    ctx.addIssue({
      code: 'custom',
      message: 'opaque kimlik nil veya ayrılmış sentinel UUID olamaz',
    });
    return z.NEVER;
  }

  if (UUID_SHAPED_ID.test(value)) {
    const entityId = EntityIdSchema.safeParse(value);
    if (!entityId.success) {
      ctx.addIssue({
        code: 'custom',
        message: 'UUID biçimli opaque kimlik strict RFC UUID olmalıdır',
      });
      return z.NEVER;
    }
    return entityId.data;
  }

  return value;
});

export type OpaqueIdentifier = z.infer<typeof OpaqueIdentifierSchema>;
