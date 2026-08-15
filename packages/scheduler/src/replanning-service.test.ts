import { describe, expect, it } from 'vitest';
import { ReplanningService } from './replanning-service.js';

describe('ReplanningService', () => {
  it('requires an active plan', async () => {
    const ch = { query: async () => ({ json: async () => [] }) } as never;
    await expect(new ReplanningService(ch).replan({ projectId: '11111111-1111-4111-8111-111111111111', reason: 'reject', summary: 'revise', now: new Date().toISOString() })).rejects.toThrow('aktif plan');
  });
});
