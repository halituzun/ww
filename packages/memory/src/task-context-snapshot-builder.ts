import {
  getKnowledgeAsOf,
  getKnowledgeSourceRefAsOf,
  getTaskAsOf,
  getPlanAsOf,
  getPromptSourceRefAsOf,
  getLatestProjectMapSourceRefAsOf,
  RepositoryConflictError,
  type ClickHouseClient,
} from '@ww/db';
import {
  EntityIdSchema,
  SourceVersionManifestV1Schema,
  VersionedSourceRefV1Schema,
  canonicalSha256V1,
  type EntityId,
  type SourceManifestType,
  type VersionedSourceRefV1,
} from '@ww/shared';
import type {
  TaskContextSnapshot,
  TaskContextSnapshotBuildInput,
  TaskContextSnapshotPort,
} from './ports.js';

function deterministicEntityId(namespace: string, value: unknown): EntityId {
  const hex = canonicalSha256V1({ namespace, value });
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return EntityIdSchema.parse(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
  );
}

function asManifestType(
  ref: VersionedSourceRefV1,
  sourceType: SourceManifestType,
): VersionedSourceRefV1 {
  return VersionedSourceRefV1Schema.parse({ ...ref, sourceType });
}

function uniqueSortedIds(values: readonly EntityId[]): readonly EntityId[] {
  return Object.freeze([...new Set(values)].sort());
}

function assertUniqueManifestIdentities(
  values: readonly VersionedSourceRefV1[],
): void {
  const identities = new Set<string>();
  for (const value of values) {
    const identity = `${value.sourceType}:${value.sourceId}:${value.version}`;
    if (identities.has(identity)) {
      throw new RepositoryConflictError(`context source tekrari: ${identity}`);
    }
    identities.add(identity);
  }
}

/**
 * Phase 1's minimal temporal builder. It deliberately performs only exact,
 * caller-pinned as-of reads; semantic search and token budgeting remain Phase 2.
 */
export class TaskContextSnapshotBuilder implements TaskContextSnapshotPort {
  readonly #ch: ClickHouseClient;

  constructor(ch: ClickHouseClient) {
    this.#ch = ch;
  }

  async build(input: TaskContextSnapshotBuildInput): Promise<TaskContextSnapshot> {
    const cutoff = new Date(input.cutoffAt);
    if (!Number.isFinite(cutoff.getTime())) throw new Error('cutoffAt gecerli bir tarih olmalidir');
    if (input.taskSource.sourceType !== 'task') {
      throw new RepositoryConflictError('task context taskSource turu task olmalidir');
    }
    if (input.planSource.sourceType !== 'plan') {
      throw new RepositoryConflictError('task context planSource turu plan olmalidir');
    }
    const task = await getTaskAsOf(
      this.#ch,
      input.projectId,
      input.taskSource.sourceId,
      cutoff.toISOString(),
    );
    if (
      task === null || Number(task.version) !== input.taskSource.version ||
      canonicalSha256V1(task) !== input.taskSource.hash
    ) {
      throw new RepositoryConflictError(
        `task context taskSource repository/cutoff ile eslesmiyor: ${input.taskSource.sourceId}`,
      );
    }
    const plan = await getPlanAsOf(
      this.#ch,
      input.projectId,
      input.planSource.sourceId,
      cutoff.toISOString(),
    );
    if (
      plan === null || plan.plan_version !== input.planSource.version ||
      canonicalSha256V1(plan) !== input.planSource.hash
    ) {
      throw new RepositoryConflictError(
        `task context planSource repository/cutoff ile eslesmiyor: ${input.planSource.sourceId}`,
      );
    }

    const promptRefs: VersionedSourceRefV1[] = [];
    const promptIdentities = new Set<string>();
    for (const prompt of input.prompts) {
      const identity = `${prompt.name}@${prompt.version}`;
      if (promptIdentities.has(identity)) continue;
      promptIdentities.add(identity);
      const ref = await getPromptSourceRefAsOf(
        this.#ch,
        prompt.name,
        prompt.version,
        cutoff.toISOString(),
      );
      if (ref === null) {
        throw new RepositoryConflictError(`as-of prompt bulunamadi: ${identity}`);
      }
      promptRefs.push(ref);
    }
    if (promptRefs.length === 0) {
      throw new RepositoryConflictError('task context en az bir prompt gerektirir');
    }

    const readKnowledge = async (
      ids: readonly EntityId[],
      sourceType: 'standard' | 'requirement',
    ): Promise<VersionedSourceRefV1[]> => {
      const refs: VersionedSourceRefV1[] = [];
      for (const id of uniqueSortedIds(ids)) {
        const row = await getKnowledgeAsOf(
          this.#ch,
          input.projectId,
          id,
          cutoff.toISOString(),
        );
        if (row === null) {
          throw new RepositoryConflictError(`as-of ${sourceType} bulunamadi: ${id}`);
        }
        if (row.kind !== sourceType) {
          throw new RepositoryConflictError(
            `as-of knowledge turu ${sourceType} degil: ${id}:${row.kind}`,
          );
        }
        const ref = await getKnowledgeSourceRefAsOf(
          this.#ch,
          input.projectId,
          id,
          cutoff.toISOString(),
        );
        if (ref === null) throw new RepositoryConflictError(`as-of ${sourceType} kayboldu: ${id}`);
        refs.push(asManifestType(ref, sourceType));
      }
      return refs;
    };

    const standardRefs = await readKnowledge(input.standardKnowledgeIds, 'standard');
    const requirementRefs = await readKnowledge(input.requirementKnowledgeIds, 'requirement');
    const projectMapRef = await getLatestProjectMapSourceRefAsOf(
      this.#ch,
      input.projectId,
      cutoff.toISOString(),
    );
    const ruleManifest = input.rules.map((rule) => VersionedSourceRefV1Schema.parse({
      sourceType: 'rule',
      sourceId: rule.ruleId,
      version: rule.ruleVersion,
      hash: rule.hash,
    }));
    const manifestValues = [
      input.taskSource,
      input.planSource,
      ...promptRefs,
      ...ruleManifest,
      ...standardRefs,
      ...requirementRefs,
      ...(projectMapRef === null ? [] : [projectMapRef]),
    ];
    assertUniqueManifestIdentities(manifestValues);
    const sourceVersionManifest = SourceVersionManifestV1Schema.parse(manifestValues);
    const contextSnapshotId = deterministicEntityId('task-context-snapshot-v1', {
      projectId: input.projectId,
      cutoffAt: cutoff.toISOString(),
      sourceVersionManifest,
    });

    return Object.freeze({
      contextSnapshotId,
      baseContextCutoffAt: cutoff.toISOString(),
      promptRefs: Object.freeze(promptRefs),
      ruleRefs: Object.freeze([...input.rules]),
      standardRefs: Object.freeze(standardRefs),
      requirementRefs: Object.freeze(requirementRefs),
      sourceVersionManifest,
    });
  }
}
