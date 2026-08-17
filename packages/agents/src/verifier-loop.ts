import { normalizeVerdictArguments } from './verdict-normalize.js';
import { POLICY_RULE_IDS, StructuredVerdictV1Schema, type AssignmentAttemptV1, type EntityId, type PromptInputSnapshotV1, type StructuredVerdictV1, type TaskBriefV1, type PromptMessageV1 } from '@ww/shared';
import type { ModelRouter } from '@ww/providers';

export interface VerifierInput { readonly brief: TaskBriefV1; readonly attempt: AssignmentAttemptV1; readonly snapshot: PromptInputSnapshotV1; readonly modelRef: string; readonly router: ModelRouter; readonly prompt: readonly PromptMessageV1[]; readonly diff: string; readonly summary: string; }
export interface VerifierResult { readonly verdict: StructuredVerdictV1; readonly invocationId: EntityId; }

function parseStrictVerdictArguments(value: unknown): StructuredVerdictV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('submit_verdict argümanı object olmalıdır');
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'verdict') throw new Error('submit_verdict yalnız verdict alanını taşımalıdır');
  // Boş kanıt referansları şemayı düşürüyordu; bilgi taşımadıkları için ayıklanır.
  return StructuredVerdictV1Schema.parse(
    normalizeVerdictArguments((value as { verdict?: unknown }).verdict),
  );
}

const VERDICT_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object', additionalProperties: false, required: ['verdict'], properties: {
    verdict: { type: 'object', additionalProperties: false, required: ['decision', 'reasons', 'evidenceRefs', 'ruleRefs'], properties: {
      decision: { enum: ['approve', 'reject'] },
      reasons: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['message', 'evidenceRefs'], properties: { message: { type: 'string', minLength: 1 }, evidenceRefs: { type: 'array', items: { type: 'string' } }, rule: { type: 'object', additionalProperties: false, required: ['ruleId', 'ruleVersion'], properties: { ruleId: { type: 'string' }, ruleVersion: { type: 'integer', minimum: 1 } } } } } },
      evidenceRefs: { type: 'array', items: { type: 'string', minLength: 1 } }, ruleRefs: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['ruleId', 'ruleVersion'], properties: { ruleId: { enum: [...POLICY_RULE_IDS] }, ruleVersion: { type: 'integer', minimum: 1 } } } },
    } },
  },
};

export async function runVerifierLoop(input: VerifierInput): Promise<VerifierResult> {
  const result = await input.router.complete(input.modelRef, { messages: [...input.prompt], tools: [{ name: 'submit_verdict', description: 'Submit strict verifier verdict', parameters: VERDICT_TOOL_PARAMETERS }], meta: { projectId: input.brief.projectId, agentId: input.attempt.verifierAgentId, taskId: input.brief.taskId, purpose: 'completion', invocationId: input.snapshot.invocationId, taskBriefId: input.brief.taskBriefId, assignmentAttemptId: input.attempt.assignmentAttemptId, promptInputSnapshotId: input.snapshot.promptInputSnapshotId } });
  if (result.result.toolCalls.length !== 1 || result.result.toolCalls[0]?.name !== 'submit_verdict') {
    throw new Error('verifier yalnız tek bir submit_verdict çağırmalıdır');
  }
  const tool = result.result.toolCalls[0];
  const verdict = parseStrictVerdictArguments(tool.args);
  return { verdict, invocationId: input.snapshot.invocationId };
}
