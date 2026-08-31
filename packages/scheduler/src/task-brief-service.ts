import type { ClickHouseClient } from '@ww/db';
import {
  acquireFencedLease,
  appendEvent,
  appendTaskBrief,
  getLatestTask,
  getPlanAsOf,
  getTaskDurableMaxLeaseFence,
  getTaskBrief,
  taskLockKey,
  type TaskRow,
  type WwRedis,
} from '@ww/db';
import type { TaskContextSnapshotPort } from '@ww/memory';
import {
  NIL_UUID,
  TaskBriefV1Schema,
  VersionedSourceRefV1Schema,
  canonicalSha256V1,
  type TaskBriefV1,
  type VersionedRuleRefV1,
} from '@ww/shared';
import { SchedulerError, schedulerBoundaryError } from './errors.js';
import { FencedLeaseGuard } from './fenced-lease-guard.js';
import {
  DEFAULT_TASK_RULE_REFS_V1,
  deterministicSchedulerEntityId,
  systemClock,
  type ClockPort,
  type SealTaskBriefInput,
} from './ports.js';

function safeVersion(value: string, context: string): number {
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SchedulerError('INTEGRITY_CONFLICT', `${context} guvenli tamsayi araligini asti`);
  }
  return Number(parsed);
}

function cleanNonempty(values: readonly string[], context: string): readonly string[] {
  const cleaned = values.map((value) => value.trim());
  if (cleaned.some((value) => value.length === 0)) {
    throw new SchedulerError('INTEGRITY_CONFLICT', `${context} bos deger iceremez`);
  }
  return Object.freeze([...new Set(cleaned)]);
}

function promptIdentity(name: string, version: number): string {
  return `${name}@${version}`;
}

function ruleIdentity(rule: VersionedRuleRefV1): string {
  return `${rule.ruleId}@${rule.ruleVersion}:${rule.hash}`;
}

export interface TaskBriefServiceOptions {
  readonly clock?: ClockPort;
  readonly redis: WwRedis;
  readonly leaseTtlMs?: number;
  readonly projectMapSnapshotter?: ProjectMapSnapshotterPort;
}

export interface ProjectMapSnapshotterPort {
  snapshot(input: {
    readonly projectId: string;
    readonly cutoffAt: string;
  }): Promise<void>;
}

export function taskBriefIdFor(
  intendedContract: unknown,
) {
  return deterministicSchedulerEntityId('task-brief-v1', intendedContract);
}

export class TaskBriefService {
  readonly #projectId: string;
  readonly #ch: ClickHouseClient;
  readonly #snapshotBuilder: TaskContextSnapshotPort;
  readonly #clock: ClockPort;
  readonly #redis: WwRedis;
  readonly #leaseTtlMs: number;
  readonly #projectMapSnapshotter: ProjectMapSnapshotterPort | undefined;

  constructor(
    projectId: string,
    ch: ClickHouseClient,
    snapshotBuilder: TaskContextSnapshotPort,
    options: TaskBriefServiceOptions,
  ) {
    this.#projectId = projectId;
    this.#ch = ch;
    this.#snapshotBuilder = snapshotBuilder;
    this.#clock = options.clock ?? systemClock;
    this.#redis = options.redis;
    this.#leaseTtlMs = options.leaseTtlMs ?? 60_000;
    this.#projectMapSnapshotter = options.projectMapSnapshotter;
  }

  async seal(input: SealTaskBriefInput): Promise<TaskBriefV1> {
    try {
      return await this.#seal(input);
    } catch (error) {
      throw schedulerBoundaryError(error, 'task brief seal', 'TASK_NOT_FOUND');
    }
  }

  async #seal(input: SealTaskBriefInput): Promise<TaskBriefV1> {
    const observed = await getLatestTask(this.#ch, this.#projectId, input.taskId);
    if (observed === null) {
      throw new SchedulerError('TASK_NOT_FOUND', `task bulunamadi: ${input.taskId}`);
    }
    const lease = await acquireFencedLease(
      this.#redis,
      taskLockKey(input.taskId),
      `brief:${input.taskId}`,
      this.#leaseTtlMs,
      await this.#minimumFence(observed),
    );
    if (lease === null) {
      throw new SchedulerError('STALE_FENCE', `task brief lease mesgul: ${input.taskId}`);
    }
    const guard = new FencedLeaseGuard(this.#redis, lease, this.#leaseTtlMs);
    try {
      return await this.sealWithGuard(input, guard);
    } finally {
      await guard.stop(true);
    }
  }

  async sealWithGuard(
    input: SealTaskBriefInput,
    guard: FencedLeaseGuard,
  ): Promise<TaskBriefV1> {
    try {
      return await this.#sealWithGuard(input, guard);
    } catch (error) {
      throw schedulerBoundaryError(error, 'task brief seal', 'TASK_NOT_FOUND');
    }
  }

  async #sealWithGuard(
    input: SealTaskBriefInput,
    guard: FencedLeaseGuard,
  ): Promise<TaskBriefV1> {
    if (guard.lease.lockKey !== taskLockKey(input.taskId)) {
      throw new SchedulerError('STALE_FENCE', 'task brief lease task kimligiyle eslesmiyor');
    }
    await guard.assertHeld();
    const task = await guard.after(getLatestTask(this.#ch, this.#projectId, input.taskId));
    if (task === null) throw new SchedulerError('TASK_NOT_FOUND', `task bulunamadi: ${input.taskId}`);
    if (task.plan_id === NIL_UUID) {
      throw new SchedulerError('INTEGRITY_CONFLICT', `task plan kimligi tasimiyor: ${task.task_id}`);
    }
    if (input.planId !== undefined && !input.rebase) {
      throw new SchedulerError('INTEGRITY_CONFLICT', 'plan degisikligi yalniz explicit rebase ile yapilabilir');
    }
    const currentBrief = task.task_brief_id === NIL_UUID
      ? null
      : await guard.after(getTaskBrief(this.#ch, task.task_brief_id));
    if (task.task_brief_id !== NIL_UUID && currentBrief === null) {
      throw new SchedulerError('INTEGRITY_CONFLICT', 'task current brief kaydi bulunamadi');
    }
    if (!input.rebase && currentBrief !== null) {
      this.#assertReplayIntent(task, currentBrief, input);
      await this.#appendBriefEvent(currentBrief, 'brief_sealed', guard);
      return currentBrief;
    }
    if (input.rebase && currentBrief === null) {
      throw new SchedulerError('INTEGRITY_CONFLICT', 'ilk brief rebase olarak muhurlenemez');
    }

    const cutoffAt = new Date(input.baseContextCutoffAt ?? this.#clock.now()).toISOString();
    const planId = input.planId ?? task.plan_id;
    const plan = await guard.after(getPlanAsOf(this.#ch, this.#projectId, planId, cutoffAt));
    if (plan === null) {
      throw new SchedulerError(
        'INTEGRITY_CONFLICT',
        `plan kaynagi base context cutoff aninda bulunamadi: ${planId}`,
      );
    }
    if (plan.project_id !== task.project_id) {
      throw new SchedulerError('INTEGRITY_CONFLICT', 'task ve plan proje kimligi eslesmiyor');
    }

    const taskBriefVersion = (currentBrief?.taskBriefVersion ?? 0) + 1;
    if (Date.parse(task.updated_at) > Date.parse(cutoffAt)) {
      throw new SchedulerError('INTEGRITY_CONFLICT', 'task kaynagi base context cutoff sonrasinda');
    }
    if (Date.parse(plan.observed_at) > Date.parse(cutoffAt)) {
      throw new SchedulerError('INTEGRITY_CONFLICT', 'plan kaynagi base context cutoff sonrasinda');
    }
    const acceptanceCriteria = cleanNonempty(
      input.acceptanceCriteria ?? [task.description.trim() || task.title],
      'acceptanceCriteria',
    );
    const allowedTools = cleanNonempty(input.allowedTools ?? [], 'allowedTools');
    const ruleRefs = Object.freeze([...(input.ruleRefs ?? DEFAULT_TASK_RULE_REFS_V1)]);
    const taskVersion = safeVersion(task.version, 'task.version');
    const planHash = canonicalSha256V1(plan);
    const taskSource = VersionedSourceRefV1Schema.parse({
      sourceType: 'task',
      sourceId: task.task_id,
      version: taskVersion,
      hash: canonicalSha256V1(task),
    });
    const planSource = VersionedSourceRefV1Schema.parse({
      sourceType: 'plan',
      sourceId: plan.plan_id,
      version: plan.plan_version,
      hash: planHash,
    });
    if (this.#projectMapSnapshotter !== undefined) {
      await guard.after(this.#projectMapSnapshotter.snapshot({
        projectId: task.project_id,
        cutoffAt,
      }));
    }
    const snapshot = await guard.after(this.#snapshotBuilder.build({
      projectId: task.project_id,
      taskSource,
      planSource,
      prompts: [input.workerPrompt, input.verifierPrompt],
      rules: ruleRefs,
      standardKnowledgeIds: input.standardKnowledgeIds ?? [],
      requirementKnowledgeIds: input.requirementKnowledgeIds ?? [],
      cutoffAt,
    }));
    const intendedContract = Object.freeze({
      contractVersion: 1,
      taskBriefVersion,
      projectId: task.project_id,
      taskId: task.task_id,
      taskVersion,
      planId: plan.plan_id,
      planVersion: plan.plan_version,
      planHash,
      goal: task.description.trim() || task.title,
      acceptanceCriteria,
      dependencyTaskIds: task.depends_on,
      targetFiles: cleanNonempty(task.target_files, 'targetFiles'),
      allowedTools,
      tokenBudget: task.token_budget,
      promptRefs: snapshot.promptRefs,
      ruleRefs: snapshot.ruleRefs,
      standardRefs: snapshot.standardRefs,
      contextSnapshotId: snapshot.contextSnapshotId,
      baseContextCutoffAt: snapshot.baseContextCutoffAt,
      sourceVersionManifest: snapshot.sourceVersionManifest,
      verificationMode: 'required' as const,
    });
    const taskBriefId = taskBriefIdFor(intendedContract);
    const existing = await guard.after(getTaskBrief(this.#ch, taskBriefId));
    const brief = TaskBriefV1Schema.parse({
      ...intendedContract,
      taskBriefId,
      sealedAt: cutoffAt,
    });
    if (existing !== null && canonicalSha256V1(existing) !== canonicalSha256V1(brief)) {
      throw new SchedulerError(
        'INTEGRITY_CONFLICT',
        `task brief deterministic kimlik/contract hash catismasi: ${taskBriefId}`,
      );
    }
    await guard.assertHeld();
    const stored = existing ?? await guard.after(appendTaskBrief(this.#ch, brief));
    await this.#appendBriefEvent(
      stored,
      input.rebase ? 'brief_rebased' : 'brief_sealed',
      guard,
    );
    return stored;
  }

  async #minimumFence(task: TaskRow): Promise<string> {
    return getTaskDurableMaxLeaseFence(this.#ch, task.task_id);
  }

  #assertReplayIntent(
    task: Awaited<ReturnType<typeof getLatestTask>> & object,
    brief: TaskBriefV1,
    input: SealTaskBriefInput,
  ): void {
    const expected = {
      planId: input.planId ?? task.plan_id,
      goal: task.description.trim() || task.title,
      acceptanceCriteria: cleanNonempty(
        input.acceptanceCriteria ?? [task.description.trim() || task.title],
        'acceptanceCriteria',
      ),
      dependencyTaskIds: [...task.depends_on],
      targetFiles: cleanNonempty(task.target_files, 'targetFiles'),
      allowedTools: cleanNonempty(input.allowedTools ?? [], 'allowedTools'),
      tokenBudget: task.token_budget,
      prompts: [...new Set([
        promptIdentity(input.workerPrompt.name, input.workerPrompt.version),
        promptIdentity(input.verifierPrompt.name, input.verifierPrompt.version),
      ])].sort(),
      rules: [...(input.ruleRefs ?? DEFAULT_TASK_RULE_REFS_V1)].map(ruleIdentity).sort(),
      standards: [...new Set(input.standardKnowledgeIds ?? [])].sort(),
      requirements: [...new Set(input.requirementKnowledgeIds ?? [])].sort(),
      ...(input.baseContextCutoffAt === undefined
        ? { baseContextCutoffAt: brief.baseContextCutoffAt }
        : { baseContextCutoffAt: new Date(input.baseContextCutoffAt).toISOString() }),
    };
    const actual = {
      planId: brief.planId,
      goal: brief.goal,
      acceptanceCriteria: [...brief.acceptanceCriteria],
      dependencyTaskIds: [...brief.dependencyTaskIds],
      targetFiles: [...brief.targetFiles],
      allowedTools: [...brief.allowedTools],
      tokenBudget: brief.tokenBudget,
      prompts: brief.promptRefs.map((ref) => promptIdentity(ref.sourceId, ref.version)).sort(),
      rules: brief.ruleRefs.map(ruleIdentity).sort(),
      standards: brief.standardRefs.map((ref) => ref.sourceId).sort(),
      requirements: brief.sourceVersionManifest
        .filter((ref) => ref.sourceType === 'requirement')
        .map((ref) => ref.sourceId)
        .sort(),
      baseContextCutoffAt: brief.baseContextCutoffAt,
    };
    if (canonicalSha256V1(expected) !== canonicalSha256V1(actual)) {
      throw new SchedulerError(
        'INTEGRITY_CONFLICT',
        `task brief replay intended contract ile catismali: ${brief.taskBriefId}`,
      );
    }
  }

  async #appendBriefEvent(
    brief: TaskBriefV1,
    eventType: 'brief_sealed' | 'brief_rebased',
    guard: FencedLeaseGuard,
  ): Promise<void> {
    const eventId = deterministicSchedulerEntityId(eventType, {
      taskBriefId: brief.taskBriefId,
      taskBriefVersion: brief.taskBriefVersion,
    });
    await guard.assertHeld();
    await guard.after(appendEvent(this.#ch, {
      event_id: eventId,
      seq: String(Date.parse(brief.sealedAt)),
      project_id: brief.projectId,
      task_id: brief.taskId,
      agent_id: NIL_UUID,
      event_type: eventType,
      tool_name: '',
      payload: {
        contractVersion: 1,
        taskBriefId: brief.taskBriefId,
        taskBriefVersion: brief.taskBriefVersion,
        taskVersion: brief.taskVersion,
        contextSnapshotId: brief.contextSnapshotId,
        contractHash: canonicalSha256V1(brief),
      },
      duration_ms: 0,
      created_at: brief.sealedAt,
    }));
  }
}
