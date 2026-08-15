import { describe, expect, it } from 'vitest';
import { NIL_UUID } from '@ww/shared';
import { DelegationService } from './delegation-service.js';

const parentId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const issuerId = '33333333-3333-4333-8333-333333333333';

function fakeDb(rows: readonly Record<string, unknown>[]) {
  return { query: async () => ({ json: async () => rows }) } as never;
}

describe('DelegationService bütçe ve soy ağacı sınırları', () => {
  it('harcanmış tokenleri parent kalan bütçesinden düşer', async () => {
    const service = new DelegationService(fakeDb([{ task_id: parentId, project_id: projectId, parent_task_id: NIL_UUID, delegation_depth: 0, token_budget: 10, tokens_spent: '7', issuer_agent_id: issuerId }]));
    await expect(service.createSubtask({ parentTaskId: parentId as never, issuerAgentId: issuerId as never, title: 'too large', acceptanceCriteria: [], targetFiles: [], group: 'coding', budget: 4 })).rejects.toThrow(/kalan butcesi/);
  });

  it('parent veya dependency soy ağacına dönen cycleı reddeder', async () => {
    const service = new DelegationService(fakeDb([{ task_id: parentId, project_id: projectId, parent_task_id: NIL_UUID, delegation_depth: 0, token_budget: 10, tokens_spent: '0', issuer_agent_id: issuerId }]));
    await expect(service.createSubtask({ parentTaskId: parentId as never, issuerAgentId: issuerId as never, title: 'cycle', acceptanceCriteria: [], targetFiles: [], group: 'coding', budget: 1, dependencies: [parentId as never] })).rejects.toThrow(/cycle/);
  });
});
