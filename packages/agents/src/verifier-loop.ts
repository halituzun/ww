import { normalizeVerdictArguments } from './verdict-normalize.js';
import { selectVerdictCall } from './verdict-selection.js';
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
  // Model verdikti birden çok kez gönderebiliyor; aynı içerik hoş görülür,
  // çelişkili içerik reddedilir (belirsizlik sessizce çözülmez).
  let calls = result.result.toolCalls as never as readonly { name: string; args: unknown }[];

  // Model bazen aracı hiç çağırmadan düz metin döner ve verdikt alınamaz;
  // sağlayıcı katmanında tool_choice zorlaması yok. TEK bir kararlı yeniden
  // deneme, yaygın bu davranışı görevi düşürmeden aşar. İkinci kez de
  // çağırmazsa hata açık kalır: verdikt UYDURULMAZ.
  if (!calls.some((call) => call.name === 'submit_verdict')) {
    const retry = await input.router.complete(input.modelRef, {
      messages: [
        ...input.prompt,
        {
          role: 'user',
          content: 'Yanıt olarak DÜZ METİN kabul edilmiyor. Kararını yalnızca '
            + 'submit_verdict aracını çağırarak bildir.',
        },
      ],
      tools: [{ name: 'submit_verdict', description: 'Submit strict verifier verdict', parameters: VERDICT_TOOL_PARAMETERS }],
      meta: { projectId: input.brief.projectId, agentId: input.attempt.verifierAgentId, taskId: input.brief.taskId, purpose: 'completion', invocationId: input.snapshot.invocationId, taskBriefId: input.brief.taskBriefId, assignmentAttemptId: input.attempt.assignmentAttemptId, promptInputSnapshotId: input.snapshot.promptInputSnapshotId },
    } as never);
    calls = retry.result.toolCalls as never;
  }

  let tool = selectVerdictCall(calls);
  let verdict: StructuredVerdictV1;
  try {
    verdict = parseStrictVerdictArguments(tool.args);
  } catch (schemaError) {
    // Verdikt şemayı tutturamadıysa (ör. `reasons` boş) EKSİĞİ UYDURMAYIZ:
    // gerekçe verifier'ın işidir. Modele tam olarak neyin yanlış olduğunu
    // söyleyip BİR kez daha isteriz; yine tutturamazsa hata açık kalır.
    const detail = schemaError instanceof Error ? schemaError.message : String(schemaError);
    const retry = await input.router.complete(input.modelRef, {
      messages: [
        ...input.prompt,
        {
          role: 'user',
          content: `Önceki verdiktin şemayı sağlamadı: ${detail}\n`
            + 'Aynı kararı, eksik alanları doldurarak submit_verdict ile yeniden gönder. '
            + 'reasons en az bir gerekçe içermelidir.',
        },
      ],
      tools: [{ name: 'submit_verdict', description: 'Submit strict verifier verdict', parameters: VERDICT_TOOL_PARAMETERS }],
      meta: { projectId: input.brief.projectId, agentId: input.attempt.verifierAgentId, taskId: input.brief.taskId, purpose: 'completion', invocationId: input.snapshot.invocationId, taskBriefId: input.brief.taskBriefId, assignmentAttemptId: input.attempt.assignmentAttemptId, promptInputSnapshotId: input.snapshot.promptInputSnapshotId },
    } as never);
    tool = selectVerdictCall(retry.result.toolCalls as never);
    verdict = parseStrictVerdictArguments(tool.args);
  }
  return { verdict, invocationId: input.snapshot.invocationId };
}
