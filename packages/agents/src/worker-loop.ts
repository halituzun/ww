import { EntityIdSchema, type TaskBriefV1, type AssignmentAttemptV1, type PromptInputSnapshotV1, type EntityId, type JsonObject, type JsonValue, type PromptMessageV1 } from '@ww/shared';
import type { ModelRouter, NormalizedToolCall, ToolDef } from '@ww/providers';

export type WorkerStopReason = 'question' | 'report' | 'deadline' | 'budget' | 'failure';
export interface WorkerToolPort { definitions(): readonly ToolDef[]; validate(name: string, args: unknown): unknown; execute(call: Readonly<{ callId: EntityId; name: string; args: unknown; occurredAt: string }>): Promise<JsonValue>; }
export interface WorkerCommunicationPort { question(input: Readonly<{ projectId: EntityId; taskId: EntityId; taskBriefId: EntityId; assignmentAttemptId: EntityId; callId: EntityId; text: string }>): Promise<Readonly<{ messageId: EntityId }>>; report(summary: string, evidenceRefs: readonly string[], provenance: Readonly<{ invocationId: EntityId; promptInputSnapshotId: EntityId }>): Promise<void>; }
export interface WorkerLoopInput { readonly brief: TaskBriefV1; readonly attempt: AssignmentAttemptV1; readonly snapshot: PromptInputSnapshotV1; readonly modelRef: string; readonly router: ModelRouter; readonly tools: WorkerToolPort; readonly communication?: WorkerCommunicationPort; readonly prompt: readonly PromptMessageV1[]; readonly maxTurns?: number; readonly now?: () => string; }
export interface WorkerLoopResult { readonly reason: WorkerStopReason; readonly turns: number; readonly summary?: string; readonly questionMessageId?: EntityId; readonly question?: string; }

export async function runWorkerLoop(input: WorkerLoopInput): Promise<WorkerLoopResult> {
  const maxTurns = input.maxTurns ?? 16;
  const now = input.now ?? (() => new Date().toISOString());
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 32) throw new Error('worker maxTurns 1 ile 32 arasında güvenli tam sayı olmalıdır');
  const messages = [...input.prompt];
  const allowedDefinitions = () => input.tools.definitions().filter((definition) => input.brief.allowedTools.includes(definition.name));
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (input.brief.deadlineAt !== undefined && Date.parse(now()) >= Date.parse(input.brief.deadlineAt)) return { reason: 'deadline', turns: turn };
    const result = await input.router.complete(input.modelRef, {
      messages,
      tools: [...allowedDefinitions()],
      meta: { projectId: input.brief.projectId, agentId: input.attempt.workerAgentId, taskId: input.brief.taskId, purpose: 'completion', invocationId: input.snapshot.invocationId, taskBriefId: input.brief.taskBriefId, assignmentAttemptId: input.attempt.assignmentAttemptId, promptInputSnapshotId: input.snapshot.promptInputSnapshotId },
    });
    if (result.result.toolCalls.length === 0) {
      const summary = result.result.content?.trim();
      if (!summary) return { reason: 'failure', turns: turn + 1 };
      if (input.communication === undefined) return { reason: 'failure', turns: turn + 1 };
      await input.communication.report(summary, [], { invocationId: input.snapshot.invocationId, promptInputSnapshotId: input.snapshot.promptInputSnapshotId });
      return { reason: 'report', turns: turn + 1, summary };
    }
    const registeredTools = new Set(allowedDefinitions().map((definition) => definition.name));
    for (const toolCall of result.result.toolCalls as readonly NormalizedToolCall[]) {
      if (!registeredTools.has(toolCall.name)) return { reason: 'failure', turns: turn + 1 };
      let args: unknown;
      let parsedCallId: EntityId;
      try {
        parsedCallId = EntityIdSchema.parse(toolCall.id);
        args = input.tools.validate(toolCall.name, toolCall.args);
      } catch {
        return { reason: 'failure', turns: turn + 1 };
      }
      if (toolCall.name === 'ask_question') {
        const candidate = typeof args === 'object' && args !== null && 'content' in args ? (args as { content: unknown }).content : undefined;
        const text = typeof candidate === 'string' ? candidate.trim() : '';
        if (!text) return { reason: 'failure', turns: turn + 1 };
        if (input.communication === undefined) return { reason: 'failure', turns: turn + 1 };
        const message = await input.communication.question({ projectId: input.brief.projectId, taskId: input.brief.taskId, taskBriefId: input.brief.taskBriefId, assignmentAttemptId: input.attempt.assignmentAttemptId, callId: parsedCallId, text });
        return { reason: 'question', turns: turn + 1, questionMessageId: message.messageId, question: text };
      }
      if (toolCall.name === 'report_result') {
        const reportArgs = args as { summary?: unknown; evidenceRefs?: unknown };
        if (typeof reportArgs.summary !== 'string' || !Array.isArray(reportArgs.evidenceRefs) || !reportArgs.evidenceRefs.every((x) => typeof x === 'string')) return { reason: 'failure', turns: turn + 1 };
        await input.tools.execute({ callId: parsedCallId, name: toolCall.name, args, occurredAt: now() });
        return { reason: 'report', turns: turn + 1, summary: reportArgs.summary };
      }
      let toolResult: JsonValue;
      try {
        toolResult = await input.tools.execute({ callId: parsedCallId, name: toolCall.name, args, occurredAt: now() });
      } catch {
        return { reason: 'failure', turns: turn + 1 };
      }
      messages.push({ role: 'tool', toolCallId: parsedCallId, content: JSON.stringify(toolResult) });
    }
    messages.splice(messages.length - result.result.toolCalls.length, 0, {
      role: 'assistant',
      content: result.result.content ?? '',
      toolCalls: result.result.toolCalls.map((call) => ({ id: call.id, name: call.name, args: typeof call.args === 'object' && call.args !== null && !Array.isArray(call.args) ? call.args as JsonObject : {} })),
    });
  }
  return { reason: 'budget', turns: maxTurns };
}
