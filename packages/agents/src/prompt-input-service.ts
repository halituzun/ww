import {
  appendPromptInputSnapshot,
  getMessage,
  getTaskHandoff,
  listTaskCausalEntriesThroughCursor,
  type ClickHouseClient,
} from '@ww/db';
import {
  PromptInputSnapshotV1Schema,
  canonicalSha256V1,
  type EntityId,
  type PromptInputSnapshotV1,
  type PromptMessageV1,
} from '@ww/shared';
import { SYSTEM_SENTINEL, USER_SENTINEL } from '@ww/shared';
import type {
  TaskContextSnapshotBuildInput,
  TaskContextSnapshotPort,
} from '@ww/memory';

export interface PromptCausalInput {
  readonly assignmentAttemptId: EntityId;
  readonly ordinal: number;
  readonly message: PromptMessageV1;
}

export interface BuildPromptInput extends TaskContextSnapshotBuildInput {
  readonly promptInputSnapshotId: EntityId;
  readonly invocationId: EntityId;
  readonly taskId: EntityId;
  readonly taskBriefId: EntityId;
  readonly assignmentAttemptId: EntityId;
  readonly messages: readonly PromptMessageV1[];
  readonly cursorOrdinal: number;
  readonly causalEntries?: readonly PromptCausalInput[];
  readonly sealedAt: string;
}

/**
 * Creates the immutable input sent to a provider. The caller pins all source
 * versions and the causal cursor; this service never performs active-plan
 * lookup or semantic retrieval, and replay can therefore load the exact
 * persisted snapshot later.
 */
export class PromptInputService {
  constructor(
    private readonly contextBuilder: TaskContextSnapshotPort,
    private readonly ch: ClickHouseClient,
  ) {}

  async build(input: BuildPromptInput): Promise<PromptInputSnapshotV1> {
    if (input.messages.length === 0) throw new Error('prompt input en az bir mesaj gerektirir');
    if (input.messages.length > 256) throw new Error('prompt input mesaj sinirini asti');
    if (!Number.isSafeInteger(input.cursorOrdinal) || input.cursorOrdinal < 0) {
      throw new Error('prompt input causal high-water gecersiz');
    }
    if (Date.parse(input.cutoffAt) > Date.parse(input.sealedAt)) {
      throw new Error('prompt cutoff sealedAt sonrasinda olamaz');
    }
    const context = await this.contextBuilder.build(input);
    // Never trust a caller-provided list: read only the bounded, typed causal
    // prefix from ClickHouse. `causalEntries` is retained only for source
    // compatibility and is deliberately ignored.
    const causalRows = await listTaskCausalEntriesThroughCursor(
      this.ch,
      input.taskId,
      input.assignmentAttemptId,
      input.cursorOrdinal,
    );
    const causalEntries = [] as PromptCausalInput[];
    for (const row of causalRows) {
      if (row.task_id !== input.taskId || row.task_brief_id !== input.taskBriefId) {
        throw new Error('causal input task/brief provenance catismasi');
      }
      const messageIds: EntityId[] = [];
      if (row.source_type === 'handoff') {
        const handoff = await getTaskHandoff(this.ch, row.source_id);
        if (handoff === null || handoff.projectId !== input.projectId ||
            handoff.taskId !== input.taskId || handoff.taskBriefId !== input.taskBriefId ||
            handoff.toAssignmentAttemptId !== row.assignment_attempt_id) {
          throw new Error('causal handoff provenance catismasi');
        }
        messageIds.push(...handoff.pendingQuestionMessageIds);
      } else if (row.source_type === 'message' ||
          ['answer', 'rejection', 'gate', 'escalation'].includes(row.source_type)) {
        // These source types are message references by contract. Retry and
        // sealed scheduler sources carry causation/attempt IDs, not messages.
        messageIds.push(row.source_id as EntityId);
      }
      for (const messageId of messageIds) {
        const message = await getMessage(this.ch, input.projectId, messageId);
        if (message === null || message.protocolVersion !== 1) {
          throw new Error('causal source canonical message bulunamadi');
        }
        if (message.envelope.taskId !== input.taskId ||
            message.envelope.taskBriefId !== input.taskBriefId ||
            (message.envelope.assignmentAttemptId !== undefined &&
              message.envelope.assignmentAttemptId !== row.assignment_attempt_id)) {
          throw new Error('causal message provenance catismasi');
        }
        const expectedKinds: Record<string, readonly string[]> = {
          answer: ['answer'],
          rejection: ['verdict', 'report'],
          gate: ['report', 'verdict'],
          escalation: ['escalation'],
          message: [],
        };
        const allowedKinds = expectedKinds[row.source_type];
        if (allowedKinds !== undefined && allowedKinds.length > 0 &&
            !allowedKinds.includes(message.envelope.kind)) {
          throw new Error('causal source message kind catismasi');
        }
        const role = message.envelope.senderPrincipalId === SYSTEM_SENTINEL
          ? 'system'
          : message.envelope.senderPrincipalId === USER_SENTINEL ? 'user' : 'assistant';
        causalEntries.push({
          assignmentAttemptId: row.assignment_attempt_id,
          ordinal: row.ordinal,
          message: { role, content: message.content },
        });
      }
    }
    const messages = Object.freeze([
      ...input.messages,
      ...causalEntries
        .slice()
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((entry) => entry.message),
    ]);
    const snapshot = PromptInputSnapshotV1Schema.parse({
      contractVersion: 1,
      promptInputSnapshotId: input.promptInputSnapshotId,
      invocationId: input.invocationId,
      projectId: input.projectId,
      taskId: input.taskId,
      taskBriefId: input.taskBriefId,
      assignmentAttemptId: input.assignmentAttemptId,
      inputTaskCausalCursor: {
        assignmentAttemptId: input.assignmentAttemptId,
        ordinal: input.cursorOrdinal,
      },
      sourceVersionManifest: context.sourceVersionManifest,
      promptMessages: messages,
      promptHash: canonicalSha256V1(messages),
      sealedAt: input.sealedAt,
    });
    return appendPromptInputSnapshot(this.ch, snapshot);
  }
}
