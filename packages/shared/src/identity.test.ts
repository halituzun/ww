import { describe, expect, it } from 'vitest';
import {
  BROADCAST_SENTINEL,
  NIL_UUID,
  SYSTEM_SENTINEL,
  USER_SENTINEL,
} from './constants.js';
import {
  AuthenticatedPrincipalV1Schema,
  PartyRefV1Schema,
} from './communication.js';
import { EntityIdSchema, OpaqueIdentifierSchema } from './identity.js';

describe('EntityIdSchema', () => {
  it('strict RFC UUID kabul edip büyük harfleri kanonik küçük harfe dönüştürür', () => {
    expect(EntityIdSchema.parse('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'))
      .toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  it.each([
    ['nil', NIL_UUID],
    ['user', USER_SENTINEL],
    ['system', SYSTEM_SENTINEL],
    ['broadcast', BROADCAST_SENTINEL],
    ['z.guid-only version-0', '11111111-1111-0111-8111-111111111111'],
  ])('%s değerini generic concrete entity kimliği olarak reddeder', (_name, value) => {
    expect(EntityIdSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    ['user', USER_SENTINEL],
    ['system', SYSTEM_SENTINEL],
    ['broadcast', BROADCAST_SENTINEL],
  ] as const)('%s sentinel değerini yalnız explicit PartyRef dalında kabul eder', (type, id) => {
    expect(PartyRefV1Schema.safeParse({ type, id }).success).toBe(true);
    expect(PartyRefV1Schema.safeParse({ type: 'agent', id }).success).toBe(false);
  });

  it.each([
    ['user', {
      principalType: 'user',
      principalId: USER_SENTINEL,
      authenticatedAt: '2026-08-14T08:00:00.000Z',
    }],
    ['system', {
      principalType: 'system',
      principalId: SYSTEM_SENTINEL,
      serviceName: 'scheduler',
      authenticatedAt: '2026-08-14T08:00:00.000Z',
    }],
  ] as const)('%s sentinel değerini explicit authenticated principal dalında kabul eder', (
    _type,
    principal,
  ) => {
    expect(AuthenticatedPrincipalV1Schema.safeParse(principal).success).toBe(true);
    expect(AuthenticatedPrincipalV1Schema.safeParse({
      principalType: 'agent',
      principalId: principal.principalId,
      role: 'worker',
      agentVersion: 1,
      authenticatedAt: '2026-08-14T08:00:00.000Z',
    }).success).toBe(false);
  });

  it('opaque kimlikte case-sensitive adı korur ve strict UUID değerini kanonikleştirir', () => {
    expect(OpaqueIdentifierSchema.parse(' Role.Worker.Coding ')).toBe('Role.Worker.Coding');
    expect(OpaqueIdentifierSchema.parse('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'))
      .toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  it.each([
    ['nil', NIL_UUID],
    ['user', USER_SENTINEL],
    ['system', SYSTEM_SENTINEL],
    ['broadcast', BROADCAST_SENTINEL],
    ['z.guid-only UUID görünümü', '11111111-1111-0111-8111-111111111111'],
  ])('%s değerini opaque kimlik geri dönüşünden geçirmez', (_name, value) => {
    expect(OpaqueIdentifierSchema.safeParse(value).success).toBe(false);
  });
});
