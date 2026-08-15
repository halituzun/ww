import type { ModelRouter } from '@ww/providers';
import type { EntityId, PromptInputSnapshotV1, PromptMessageV1 } from '@ww/shared';
export interface PmLoopInput { readonly projectId: EntityId; readonly pmAgentId: EntityId; readonly modelRef: string; readonly router: ModelRouter; readonly snapshot: PromptInputSnapshotV1; readonly command?: string; readonly question?: string; readonly prompt: readonly PromptMessageV1[]; }
export async function runPmLoop(input: PmLoopInput): Promise<string> {
  const result = await input.router.complete(input.modelRef, { messages: [...input.prompt], meta: { projectId: input.projectId, agentId: input.pmAgentId, purpose: 'completion', invocationId: input.snapshot.invocationId, taskBriefId: input.snapshot.taskBriefId, assignmentAttemptId: input.snapshot.assignmentAttemptId, promptInputSnapshotId: input.snapshot.promptInputSnapshotId } });
  return result.result.content?.trim() ?? '';
}
