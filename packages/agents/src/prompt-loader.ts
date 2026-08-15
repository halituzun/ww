import type { PromptInputSnapshotV1, TaskBriefV1, PromptMessageV1 } from '@ww/shared';
import type { ToolDef } from '@ww/providers';

/** Loads only the immutable prompt material pinned by the brief/snapshot. */
export interface PromptLoader {
  loadWorker(input: Readonly<{ brief: TaskBriefV1; snapshot: PromptInputSnapshotV1; tools: readonly ToolDef[] }>): readonly PromptMessageV1[];
  loadVerifier(input: Readonly<{ brief: TaskBriefV1; snapshot: PromptInputSnapshotV1; diff: string; summary: string }>): readonly PromptMessageV1[];
  loadPm(input: Readonly<{ snapshot: PromptInputSnapshotV1; command?: string; question?: string }>): readonly PromptMessageV1[];
}

export class SealedPromptLoader implements PromptLoader {
  loadWorker(input: Readonly<{ brief: TaskBriefV1; snapshot: PromptInputSnapshotV1; tools: readonly ToolDef[] }>): readonly PromptMessageV1[] {
    return Object.freeze([...input.snapshot.promptMessages]);
  }

  loadVerifier(input: Readonly<{ brief: TaskBriefV1; snapshot: PromptInputSnapshotV1; diff: string; summary: string }>): readonly PromptMessageV1[] {
    return Object.freeze([
      ...input.snapshot.promptMessages,
      { role: 'user', content: `DIFF:\n${input.diff}\nSUMMARY:\n${input.summary}` },
    ]);
  }

  loadPm(input: Readonly<{ snapshot: PromptInputSnapshotV1; command?: string; question?: string }>): readonly PromptMessageV1[] {
    return Object.freeze([
      ...input.snapshot.promptMessages,
      ...(input.command === undefined ? [] : [{ role: 'user' as const, content: input.command }]),
      ...(input.question === undefined ? [] : [{ role: 'user' as const, content: input.question }]),
    ]);
  }
}
