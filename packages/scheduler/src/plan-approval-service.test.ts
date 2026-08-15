import { describe, expect, it } from 'vitest';
import { PlanApprovalService } from './plan-approval-service.js';

describe('PlanApprovalService', () => {
  it('fails closed when no plan is found', async () => {
    const ch = { query: async () => ({ json: async () => [] }) } as never;
    await expect(new PlanApprovalService(ch).apply({ projectId: '11111111-1111-4111-8111-111111111111', planId: '22222222-2222-4222-8222-222222222222', approved: true, actor: 'user', now: new Date().toISOString() })).rejects.toThrow('plan bulunamadi');
  });
});
