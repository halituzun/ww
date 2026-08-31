import { describe, expect, it } from 'vitest';
import {
  BROADCAST_SENTINEL,
  NIL_UUID,
  SYSTEM_SENTINEL,
  USER_SENTINEL,
} from './constants.js';
import { JsonValueSchema, canonicalSha256V1 } from './json.js';
import {
  AssignmentAttemptV1Schema,
  PromptMessageV1Schema,
  PromptInputSnapshotV1Schema,
  TaskBriefV1Schema,
  TaskCausalCursorV1Schema,
  TaskHandoffV1Schema,
  VersionedSourceRefV1Schema,
} from './task-contracts.js';

const ID = {
  project: '11111111-1111-4111-8111-111111111111',
  task: '22222222-2222-4222-8222-222222222222',
  brief: '33333333-3333-4333-8333-333333333333',
  plan: '44444444-4444-4444-8444-444444444444',
  snapshot: '55555555-5555-4555-8555-555555555555',
  attempt: '66666666-6666-4666-8666-666666666666',
  previousAttempt: '77777777-7777-4777-8777-777777777777',
  nextAttempt: '88888888-8888-4888-8888-888888888888',
  worker: '99999999-9999-4999-8999-999999999999',
  verifier: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  handoff: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  invocation: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
} as const;
const HASH = 'a'.repeat(64);
const CASE_ID = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const PLAN_SOURCE = { sourceType: 'plan', sourceId: ID.plan, version: 1, hash: HASH } as const;
const PROMPT_SOURCE = {
  sourceType: 'prompt',
  sourceId: 'role.worker.coding',
  version: 1,
  hash: 'b'.repeat(64),
} as const;
const RULE_SOURCE = {
  sourceType: 'rule',
  sourceId: 'COMM-001',
  version: 1,
  hash: 'c'.repeat(64),
} as const;
const STANDARD_SOURCE = {
  sourceType: 'standard',
  sourceId: 'standards/typescript',
  version: 1,
  hash: 'd'.repeat(64),
} as const;
const EXEMPTION_RULE_SOURCE = {
  sourceType: 'rule',
  sourceId: 'TASK-004',
  version: 1,
  hash: 'e'.repeat(64),
} as const;
const CYCLIC_JSON: Record<string, unknown> = {};
CYCLIC_JSON['self'] = CYCLIC_JSON;

function validBrief(): Record<string, unknown> {
  return {
    contractVersion: 1,
    taskBriefId: ID.brief,
    taskBriefVersion: 1,
    projectId: ID.project,
    taskId: ID.task,
    taskVersion: 1,
    planId: ID.plan,
    planVersion: 1,
    planHash: HASH,
    goal: 'İletişim sözleşmesini uygula.',
    acceptanceCriteria: ['Runtime parser fail-closed olur.'],
    dependencyTaskIds: [],
    targetFiles: ['packages/shared/src/communication.ts'],
    allowedTools: ['read_file', 'write_file'],
    tokenBudget: 10_000,
    deadlineAt: '2026-08-14T10:00:00.000Z',
    promptRefs: [PROMPT_SOURCE],
    ruleRefs: [{ ruleId: 'COMM-001', ruleVersion: 1, hash: RULE_SOURCE.hash }],
    standardRefs: [STANDARD_SOURCE],
    contextSnapshotId: ID.snapshot,
    baseContextCutoffAt: '2026-08-14T08:00:00.000Z',
    sourceVersionManifest: [PLAN_SOURCE, PROMPT_SOURCE, RULE_SOURCE, STANDARD_SOURCE],
    verificationMode: 'required',
    sealedAt: '2026-08-14T08:00:00.000Z',
  };
}

function validSnapshot(promptMessages: Record<string, unknown>[] = [
  { role: 'system', content: 'Pinned prompt' },
]): Record<string, unknown> {
  return {
    contractVersion: 1,
    promptInputSnapshotId: ID.snapshot,
    invocationId: ID.invocation,
    projectId: ID.project,
    taskId: ID.task,
    taskBriefId: ID.brief,
    assignmentAttemptId: ID.attempt,
    inputTaskCausalCursor: { assignmentAttemptId: ID.attempt, ordinal: 2 },
    sourceVersionManifest: [PLAN_SOURCE],
    promptMessages,
    promptHash: canonicalSha256V1(promptMessages),
    sealedAt: '2026-08-14T08:00:00.000Z',
  };
}

function validAssignment(): Record<string, unknown> {
  return {
    contractVersion: 1,
    assignmentAttemptId: ID.attempt,
    projectId: ID.project,
    taskId: ID.task,
    taskBriefId: ID.brief,
    attemptNumber: 1,
    workerAgentId: ID.worker,
    verifierAgentId: ID.verifier,
    leaseOwner: 'scheduler-1',
    leaseFence: 1,
    leaseExpiresAt: '2026-08-14T08:10:00.000Z',
    startReason: 'initial',
    assignedAt: '2026-08-14T08:00:00.000Z',
  };
}

function validHandoff(): Record<string, unknown> {
  return {
    contractVersion: 1,
    handoffId: ID.handoff,
    projectId: ID.project,
    taskId: ID.task,
    taskBriefId: ID.brief,
    fromAssignmentAttemptId: ID.attempt,
    toAssignmentAttemptId: ID.nextAttempt,
    ancestorCursor: { assignmentAttemptId: ID.attempt, ordinal: 4 },
    artifactIds: [],
    evidenceRefs: ['commit:abc1234'],
    pendingQuestionMessageIds: [],
    pendingReceiptIds: [],
    workspaceCheckpoint: { commitHash: 'abc1234', changedPaths: [] },
    leaseRelease: { status: 'released', leaseOwner: 'scheduler-1', leaseFence: 3 },
    lockRelease: { releasedLockKeys: ['file:a'], failedLockKeys: [] },
    createdAt: '2026-08-14T08:00:00.000Z',
  };
}

describe('immutable task contracts', () => {
  it('TaskBriefV1 parse sonucunu mühürler ve unknown key reddeder', () => {
    const parsed = TaskBriefV1Schema.parse(validBrief());
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(TaskBriefV1Schema.safeParse({ ...validBrief(), future: true }).success).toBe(false);
  });

  it.each([
    ['TaskBrief.taskBriefId', () => TaskBriefV1Schema.safeParse({
      ...validBrief(),
      taskBriefId: NIL_UUID,
    }).success],
    ['TaskBrief.projectId', () => TaskBriefV1Schema.safeParse({
      ...validBrief(),
      projectId: NIL_UUID,
    }).success],
    ['TaskBrief.taskId', () => TaskBriefV1Schema.safeParse({
      ...validBrief(),
      taskId: NIL_UUID,
    }).success],
    ['TaskBrief.planId', () => TaskBriefV1Schema.safeParse({
      ...validBrief(),
      planId: NIL_UUID,
    }).success],
    ['TaskBrief.dependencyTaskIds', () => TaskBriefV1Schema.safeParse({
      ...validBrief(),
      dependencyTaskIds: [NIL_UUID],
    }).success],
    ['TaskBrief.contextSnapshotId', () => TaskBriefV1Schema.safeParse({
      ...validBrief(),
      contextSnapshotId: NIL_UUID,
    }).success],
    ['Assignment.assignmentAttemptId', () => AssignmentAttemptV1Schema.safeParse({
      ...validAssignment(),
      assignmentAttemptId: NIL_UUID,
    }).success],
    ['Assignment.workerAgentId', () => AssignmentAttemptV1Schema.safeParse({
      ...validAssignment(),
      workerAgentId: NIL_UUID,
    }).success],
    ['Assignment.verifierAgentId', () => AssignmentAttemptV1Schema.safeParse({
      ...validAssignment(),
      verifierAgentId: NIL_UUID,
    }).success],
    ['Assignment.handoffId', () => AssignmentAttemptV1Schema.safeParse({
      ...validAssignment(),
      startReason: 'reassignment',
      previousAttemptId: ID.previousAttempt,
      handoffId: NIL_UUID,
    }).success],
    ['PromptInputSnapshot.promptInputSnapshotId', () => PromptInputSnapshotV1Schema.safeParse({
      ...validSnapshot(),
      promptInputSnapshotId: NIL_UUID,
    }).success],
    ['PromptInputSnapshot.invocationId', () => PromptInputSnapshotV1Schema.safeParse({
      ...validSnapshot(),
      invocationId: NIL_UUID,
    }).success],
    ['TaskHandoff.handoffId', () => TaskHandoffV1Schema.safeParse({
      ...validHandoff(),
      handoffId: NIL_UUID,
    }).success],
    ['TaskHandoff.pendingQuestionMessageIds', () => TaskHandoffV1Schema.safeParse({
      ...validHandoff(),
      pendingQuestionMessageIds: [NIL_UUID],
    }).success],
    ['TaskHandoff.pendingReceiptIds', () => TaskHandoffV1Schema.safeParse({
      ...validHandoff(),
      pendingReceiptIds: [NIL_UUID],
    }).success],
    ['TaskHandoff.artifactIds', () => TaskHandoffV1Schema.safeParse({
      ...validHandoff(),
      artifactIds: [NIL_UUID],
    }).success],
  ])('%s concrete kimliğinde nil UUID reddeder', (_field, parseSuccess) => {
    expect(parseSuccess()).toBe(false);
  });

  it('verification istisnası, cutoff ve deadline invariantlarını zorlar', () => {
    expect(TaskBriefV1Schema.safeParse({
      ...validBrief(),
      verificationMode: 'exempt',
    }).success).toBe(false);
    expect(TaskBriefV1Schema.safeParse({
      ...validBrief(),
      baseContextCutoffAt: '2026-08-14T08:01:00.000Z',
    }).success).toBe(false);
    expect(TaskBriefV1Schema.safeParse({
      ...validBrief(),
      deadlineAt: '2026-08-14T07:59:00.000Z',
    }).success).toBe(false);
    expect(TaskBriefV1Schema.safeParse({
      ...validBrief(),
      verificationMode: 'exempt',
      verificationExemptionRule: {
        ruleId: 'TASK-004',
        ruleVersion: 1,
        hash: EXEMPTION_RULE_SOURCE.hash,
      },
      sourceVersionManifest: [
        PLAN_SOURCE,
        PROMPT_SOURCE,
        RULE_SOURCE,
        STANDARD_SOURCE,
        EXEMPTION_RULE_SOURCE,
      ],
    }).success).toBe(true);
  });

  it('plan, prompt, rule ve standard referanslarını manifestte birebir mühürler', () => {
    const brief = validBrief();
    expect(TaskBriefV1Schema.safeParse({
      ...brief,
      sourceVersionManifest: [PLAN_SOURCE, RULE_SOURCE, STANDARD_SOURCE],
    }).success).toBe(false);
    expect(TaskBriefV1Schema.safeParse({
      ...brief,
      sourceVersionManifest: [
        { ...PLAN_SOURCE, hash: 'e'.repeat(64) },
        PROMPT_SOURCE,
        RULE_SOURCE,
        STANDARD_SOURCE,
      ],
    }).success).toBe(false);
    expect(TaskBriefV1Schema.safeParse({
      ...brief,
      ruleRefs: [{ ruleId: 'COMM-001', ruleVersion: 1, hash: 'e'.repeat(64) }],
    }).success).toBe(false);
    expect(TaskBriefV1Schema.safeParse({
      ...brief,
      sourceVersionManifest: [
        PLAN_SOURCE,
        { ...PLAN_SOURCE },
        PROMPT_SOURCE,
        RULE_SOURCE,
        STANDARD_SOURCE,
      ],
    }).success).toBe(false);
    expect(TaskBriefV1Schema.safeParse({
      ...brief,
      sourceVersionManifest: [
        PLAN_SOURCE,
        { ...PLAN_SOURCE, hash: 'f'.repeat(64) },
        PROMPT_SOURCE,
        RULE_SOURCE,
        STANDARD_SOURCE,
      ],
    }).success).toBe(false);
  });

  it('manifestte yalnız UUID sourceId değerlerini kanonikleştirir ve case duplicate reddeder', () => {
    const uppercasePlanId = CASE_ID.toUpperCase();
    const casePlanSource = {
      ...PLAN_SOURCE,
      sourceId: uppercasePlanId,
    };
    const parsed = TaskBriefV1Schema.parse({
      ...validBrief(),
      planId: uppercasePlanId,
      sourceVersionManifest: [casePlanSource, PROMPT_SOURCE, RULE_SOURCE, STANDARD_SOURCE],
    });

    expect(parsed.planId).toBe(CASE_ID);
    expect(parsed.sourceVersionManifest[0]?.sourceId).toBe(CASE_ID);
    expect(VersionedSourceRefV1Schema.parse({
      sourceType: 'prompt',
      sourceId: 'Role.Worker.Coding',
      version: 1,
      hash: HASH,
    }).sourceId).toBe('Role.Worker.Coding');
    expect(VersionedSourceRefV1Schema.parse({
      sourceType: 'project_map',
      sourceId: CASE_ID,
      version: 1,
      hash: HASH,
    }).sourceType).toBe('project_map');
    expect(TaskBriefV1Schema.safeParse({
      ...validBrief(),
      planId: CASE_ID,
      sourceVersionManifest: [
        { ...casePlanSource, sourceId: CASE_ID },
        casePlanSource,
        PROMPT_SOURCE,
        RULE_SOURCE,
        STANDARD_SOURCE,
      ],
    }).success).toBe(false);
  });

  it.each([
    ['nil', NIL_UUID],
    ['user sentinel', USER_SENTINEL],
    ['system sentinel', SYSTEM_SENTINEL],
    ['broadcast sentinel', BROADCAST_SENTINEL],
    ['z.guid-only UUID görünümü', '11111111-1111-0111-8111-111111111111'],
  ])('VersionedSourceRef sourceId alanında %s değerini reddeder', (_name, sourceId) => {
    expect(VersionedSourceRefV1Schema.safeParse({
      sourceType: 'prompt',
      sourceId,
      version: 1,
      hash: HASH,
    }).success).toBe(false);
  });

  it('assignment bağımsız verifier, previous attempt, handoff ve lease gerektirir', () => {
    const base = validAssignment();
    expect(AssignmentAttemptV1Schema.safeParse(base).success).toBe(true);
    expect(AssignmentAttemptV1Schema.safeParse({ ...base, verifierAgentId: ID.worker }).success).toBe(false);
    expect(AssignmentAttemptV1Schema.safeParse({
      ...base,
      startReason: 'reassignment',
      previousAttemptId: ID.previousAttempt,
    }).success).toBe(false);
    expect(AssignmentAttemptV1Schema.safeParse({
      ...base,
      startReason: 'reassignment',
      previousAttemptId: ID.previousAttempt,
      handoffId: ID.handoff,
    }).success).toBe(true);
    expect(AssignmentAttemptV1Schema.safeParse({
      ...base,
      startReason: 'reassignment',
      previousAttemptId: ID.attempt,
      handoffId: ID.handoff,
    }).success).toBe(false);
  });

  it.each([
    ['worker/verifier case varyantı', () => AssignmentAttemptV1Schema.safeParse({
      ...validAssignment(),
      workerAgentId: CASE_ID,
      verifierAgentId: CASE_ID.toUpperCase(),
    }).success],
    ['previous attempt self-cycle case varyantı', () => AssignmentAttemptV1Schema.safeParse({
      ...validAssignment(),
      assignmentAttemptId: CASE_ID,
      startReason: 'retry_after_rejection',
      previousAttemptId: CASE_ID.toUpperCase(),
    }).success],
    ['handoff from/to case varyantı', () => TaskHandoffV1Schema.safeParse({
      ...validHandoff(),
      fromAssignmentAttemptId: CASE_ID,
      toAssignmentAttemptId: CASE_ID.toUpperCase(),
      ancestorCursor: { assignmentAttemptId: CASE_ID, ordinal: 4 },
    }).success],
  ])('%s ile kimlik eşitliği invariantını aşamaz', (_name, parseSuccess) => {
    expect(parseSuccess()).toBe(false);
  });

  it('attempt bazlı causal cursor strict ve monoton ordinal biçimindedir', () => {
    expect(TaskCausalCursorV1Schema.safeParse({
      assignmentAttemptId: ID.attempt,
      ordinal: 0,
    }).success).toBe(true);
    expect(TaskCausalCursorV1Schema.safeParse({
      assignmentAttemptId: ID.attempt,
      ordinal: -1,
    }).success).toBe(false);
  });

  it('PromptInputSnapshot prompt hash ve attempt high-water eşleşmesini doğrular', () => {
    const snapshot = validSnapshot();
    expect(PromptInputSnapshotV1Schema.safeParse(snapshot).success).toBe(true);
    expect(PromptInputSnapshotV1Schema.safeParse({ ...snapshot, promptHash: HASH }).success).toBe(false);
    expect(PromptInputSnapshotV1Schema.safeParse({
      ...snapshot,
      inputTaskCausalCursor: { assignmentAttemptId: ID.previousAttempt, ordinal: 2 },
    }).success).toBe(false);
    expect(PromptInputSnapshotV1Schema.safeParse({
      ...snapshot,
      sourceVersionManifest: [PLAN_SOURCE, { ...PLAN_SOURCE }],
    }).success).toBe(false);
    expect(PromptInputSnapshotV1Schema.safeParse({
      ...snapshot,
      sourceVersionManifest: [
        PLAN_SOURCE,
        { ...PLAN_SOURCE, hash: 'f'.repeat(64) },
      ],
    }).success).toBe(false);
  });

  it('prompt mesajlarını provider rolleriyle aynı strict union üzerinden doğrular', () => {
    const messages = [
      { role: 'system', content: 'Pinned prompt' },
      { role: 'user', content: 'Görevi uygula' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'write_file', args: { path: 'a.ts' } }],
      },
      { role: 'tool', content: 'yazıldı', toolCallId: 'call-1' },
    ];
    expect(PromptInputSnapshotV1Schema.safeParse(validSnapshot(messages)).success).toBe(true);
  });

  it.each([
    ['assistant tool call id', {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: NIL_UUID, name: 'write_file', args: {} }],
    }],
    ['tool result call id', { role: 'tool', content: 'ok', toolCallId: NIL_UUID }],
  ])('%s alanında reserved sentinel kimliği reddeder', (_name, message) => {
    expect(PromptMessageV1Schema.safeParse(message).success).toBe(false);
  });

  it.each([
    ['system toolCalls', { role: 'system', content: 'x', toolCalls: [] }],
    ['user toolCallId', { role: 'user', content: 'x', toolCallId: 'call-1' }],
    ['assistant toolCallId', { role: 'assistant', content: 'x', toolCallId: 'call-1' }],
    ['tool missing toolCallId', { role: 'tool', content: 'x' }],
    ['tool with toolCalls', { role: 'tool', content: 'x', toolCallId: 'call-1', toolCalls: [] }],
  ])('%s prompt mesajını reddeder', (_name, message) => {
    expect(PromptMessageV1Schema.safeParse(message).success).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['function', () => 'nope'],
    ['symbol', Symbol('nope')],
    ['non-finite number', Number.POSITIVE_INFINITY],
    ['non-JSON object', new Date('2026-08-14T08:00:00.000Z')],
    ['cyclic object', CYCLIC_JSON],
    ['sparse array', Array(1)],
    ['symbol-keyed object', { [Symbol('nope')]: true }],
  ])('tool args içindeki %s değerini throw etmeden reddeder', (_name, invalidValue) => {
    const snapshot = {
      ...validSnapshot(),
      promptMessages: [{
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'write_file', args: { bad: invalidValue } }],
      }],
    };
    expect(() => PromptInputSnapshotV1Schema.safeParse(snapshot)).not.toThrow();
    expect(PromptInputSnapshotV1Schema.safeParse(snapshot).success).toBe(false);
  });

  it('hostile proxy ve accessor girdilerini fail-closed ve throw etmeden reddeder', () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, 'bad', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('getter invoked');
      },
    });
    const inputs: unknown[] = [
      new Proxy({ ok: 1 }, { ownKeys() { throw new Error('ownKeys trap'); } }),
      new Proxy({ ok: 1 }, {
        getOwnPropertyDescriptor() { throw new Error('descriptor trap'); },
      }),
      new Proxy({ ok: 1 }, { getPrototypeOf() { throw new Error('prototype trap'); } }),
      new Proxy([1], { ownKeys() { throw new Error('array ownKeys trap'); } }),
      accessor,
    ];

    for (const input of inputs) {
      expect(() => JsonValueSchema.safeParse(input)).not.toThrow();
      expect(JsonValueSchema.safeParse(input).success).toBe(false);
    }
    expect(getterCalls).toBe(0);
  });

  it('valid JSON girdisini caller-owned nesneden ayırıp deep-freeze eder', () => {
    const callerOwned = { nested: [{ value: 1 }] };
    const parsed = JsonValueSchema.parse(callerOwned);
    expect(parsed).not.toBe(callerOwned);
    expect(Object.isFrozen(parsed)).toBe(true);
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('JSON object bekleniyordu');
    }
    const nested = parsed['nested'];
    expect(Array.isArray(nested)).toBe(true);
    expect(Object.isFrozen(nested)).toBe(true);
    expect(Object.isFrozen(callerOwned)).toBe(false);
    callerOwned.nested[0]!.value = 2;
    expect(nested?.[0]).toEqual({ value: 1 });
  });

  it('nested tool args değerlerini deep-freeze ederek prompt hashini değişmez tutar', () => {
    const nestedInput = { value: 1 };
    const snapshot = validSnapshot([{
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call-1', name: 'write_file', args: { nested: nestedInput } }],
    }]);
    const parsed = PromptInputSnapshotV1Schema.parse(snapshot);
    const nested = parsed.promptMessages[0]!.toolCalls?.[0]?.args['nested'];
    if (nested === null || Array.isArray(nested) || typeof nested !== 'object') {
      throw new Error('nested JSON object bekleniyordu');
    }
    expect(Object.isFrozen(nested)).toBe(true);
    expect(Object.isFrozen(nestedInput)).toBe(false);
    expect(Reflect.set(nestedInput, 'value', 2)).toBe(true);
    expect(nested['value']).toBe(1);
    expect(Reflect.set(nested, 'value', 2)).toBe(false);
    expect(parsed.promptHash).toBe(canonicalSha256V1(parsed.promptMessages));
  });

  it('tool args anahtar sırasından bağımsız canonical prompt hash üretir', () => {
    const left = [{
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call-1', name: 'tool', args: { b: 2, a: { d: 4, c: 3 } } }],
    }];
    const right = [{
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call-1', name: 'tool', args: { a: { c: 3, d: 4 }, b: 2 } }],
    }];
    expect(canonicalSha256V1(left)).toBe(canonicalSha256V1(right));
  });

  it('handoff yalnız önceki attempt cursorunu yeni attempt içine mühürler', () => {
    const handoff = validHandoff();
    expect(TaskHandoffV1Schema.safeParse(handoff).success).toBe(true);
    expect(TaskHandoffV1Schema.safeParse({
      ...handoff,
      ancestorCursor: { assignmentAttemptId: ID.previousAttempt, ordinal: 4 },
    }).success).toBe(false);
    expect(TaskHandoffV1Schema.safeParse({
      ...handoff,
      leaseRelease: { status: 'failed', leaseOwner: 'scheduler-1', leaseFence: 3 },
    }).success).toBe(false);
    expect(TaskHandoffV1Schema.safeParse({
      ...handoff,
      lockRelease: { releasedLockKeys: ['file:a', 'file:a'], failedLockKeys: [] },
    }).success).toBe(false);
    expect(TaskHandoffV1Schema.safeParse({
      ...handoff,
      lockRelease: { releasedLockKeys: [], failedLockKeys: ['file:a', 'file:a'] },
    }).success).toBe(false);
    expect(TaskHandoffV1Schema.safeParse({
      ...handoff,
      lockRelease: { releasedLockKeys: ['file:a'], failedLockKeys: ['file:a'] },
    }).success).toBe(false);
  });
});
