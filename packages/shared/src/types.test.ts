import { describe, expect, it } from 'vitest';
import { NIL_UUID } from './constants.js';
import { ProviderInvocationProvenanceV1Schema } from './types.js';

const PROVENANCE = {
  invocationId: '11111111-1111-4111-8111-111111111111',
  taskBriefId: '22222222-2222-4222-8222-222222222222',
  assignmentAttemptId: '33333333-3333-4333-8333-333333333333',
  promptInputSnapshotId: '44444444-4444-4444-8444-444444444444',
  fallbackAttempt: 0,
};

describe('ProviderInvocationProvenanceV1', () => {
  it('beş provenance alanını strict runtime sözleşmesiyle doğrular', () => {
    expect(ProviderInvocationProvenanceV1Schema.safeParse(PROVENANCE).success).toBe(true);
    for (const key of Object.keys(PROVENANCE)) {
      const missing = { ...PROVENANCE } as Record<string, unknown>;
      delete missing[key];
      expect(ProviderInvocationProvenanceV1Schema.safeParse(missing).success).toBe(false);
    }
    expect(ProviderInvocationProvenanceV1Schema.safeParse({
      ...PROVENANCE,
      fallbackAttempt: -1,
    }).success).toBe(false);
    expect(ProviderInvocationProvenanceV1Schema.safeParse({
      ...PROVENANCE,
      extra: true,
    }).success).toBe(false);
  });

  it.each([
    'invocationId',
    'taskBriefId',
    'assignmentAttemptId',
    'promptInputSnapshotId',
  ] as const)('%s concrete kimliğinde nil UUID reddeder', (field) => {
    expect(ProviderInvocationProvenanceV1Schema.safeParse({
      ...PROVENANCE,
      [field]: NIL_UUID,
    }).success).toBe(false);
  });
});
