import type {
  EntityId,
  SourceVersionManifestV1,
  VersionedRuleRefV1,
  VersionedSourceRefV1,
} from '@ww/shared';

export interface PromptSourceSelection {
  readonly name: string;
  readonly version: number;
}

export interface TaskContextSnapshotBuildInput {
  readonly projectId: EntityId;
  readonly taskSource: VersionedSourceRefV1;
  readonly planSource: VersionedSourceRefV1;
  readonly prompts: readonly PromptSourceSelection[];
  readonly rules: readonly VersionedRuleRefV1[];
  readonly standardKnowledgeIds: readonly EntityId[];
  readonly requirementKnowledgeIds: readonly EntityId[];
  readonly cutoffAt: string;
}

export interface TaskContextSnapshot {
  readonly contextSnapshotId: EntityId;
  readonly baseContextCutoffAt: string;
  readonly promptRefs: readonly VersionedSourceRefV1[];
  readonly ruleRefs: readonly VersionedRuleRefV1[];
  readonly standardRefs: readonly VersionedSourceRefV1[];
  readonly requirementRefs: readonly VersionedSourceRefV1[];
  readonly sourceVersionManifest: SourceVersionManifestV1;
}

export interface TaskContextSnapshotPort {
  build(input: TaskContextSnapshotBuildInput): Promise<TaskContextSnapshot>;
}
