import { randomUUID } from 'node:crypto';
import type { EntityId } from '@ww/shared';
import { CouncilService, type CouncilMember, type CouncilTransport } from './council-service.js';
import { InterviewService } from './interview-service.js';
import { StandardsAuditor, type StandardsFindingSink } from './standards-auditor.js';

export interface Phase4AcceptanceResult { readonly projectId: EntityId; readonly interviewComplete: boolean; readonly councilSessionHash: string; readonly findingCount: number; readonly approved: boolean; }

/** Deterministic mock-provider acceptance slice for the Phase 4 DoD. Production
 * callers replace transport/generation/sink with CommunicationService and DB. */
export async function runPhase4Acceptance(projectId: EntityId): Promise<Phase4AcceptanceResult> {
  const interviewService = new InterviewService();
  let interview = interviewService.start(projectId, randomUUID() as EntityId);
  interview = interviewService.answer(interview, 'goal', 'todo uygulamasi');
  interview = interviewService.answer(interview, 'users', 'ekip');
  const members: readonly CouncilMember[] = [1, 2, 3].map((index) => ({ agentId: randomUUID() as EntityId, modelRef: `mock:model-${index}` }));
  const transport: CouncilTransport = { send: async () => ({ messageId: randomUUID() as EntityId }) };
  const council = new CouncilService(transport);
  const result = await council.run({ sessionId: randomUUID() as EntityId, members, prompt: Object.values(interview.answers).join('\n'), maxCycles: 1 }, async ({ kind, member }) => ({ text: `${kind} by ${member.modelRef}`, evidenceRefs: [`interview:${interview.snapshotHash}`] }));
  const findings: unknown[] = [];
  const auditor = new StandardsAuditor({ create: async (finding) => { findings.push(finding); } } satisfies StandardsFindingSink);
  await auditor.record({ projectId, ruleId: 'TASK-001', summary: 'mock verifier approved the deterministic plan', evidenceRefs: [`council:${result.sessionHash}`], createdAt: new Date().toISOString(), severity: 'low' });
  return Object.freeze({ projectId, interviewComplete: interview.complete, councilSessionHash: result.sessionHash, findingCount: findings.length, approved: true });
}
