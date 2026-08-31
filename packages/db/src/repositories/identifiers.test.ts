import { randomUUID } from 'node:crypto';
import { BROADCAST_SENTINEL, NIL_UUID } from '@ww/shared';
import { describe, expect, it } from 'vitest';
import {
  concreteEntityId,
  optionalEntityId,
  storedEntityIdArray,
  storedUuid,
} from './identifiers.js';
import { StoredRecordError } from './types.js';

describe('repository kimlik siniri', () => {
  it('somut kimlikleri kanoniklestirir, nil ve sentinel degerleri reddeder', () => {
    const id = randomUUID();
    expect(concreteEntityId(id.toUpperCase(), 'id')).toBe(id);
    expect(() => concreteEntityId(NIL_UUID, 'id')).toThrow(StoredRecordError);
    expect(() => concreteEntityId(BROADCAST_SENTINEL, 'id')).toThrow(StoredRecordError);
  });

  it('legacy nil varsayilanini opsiyonel repository alaninda korur', () => {
    expect(optionalEntityId(NIL_UUID, 'parent_id')).toBe(NIL_UUID);
    expect(storedUuid(NIL_UUID, 'parent_id')).toBe(NIL_UUID);
    expect(() => storedEntityIdArray([NIL_UUID], 'depends_on')).toThrow(StoredRecordError);
  });
});
