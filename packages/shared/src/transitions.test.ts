import { describe, expect, it } from 'vitest';
import { NIL_UUID } from './constants.js';
import {
  TASK_TRANSITION_ACTIONS,
  TaskTransitionRequestV1Schema,
} from './transitions.js';

const ID = {
  request: '11111111-1111-4111-8111-111111111111',
  project: '22222222-2222-4222-8222-222222222222',
  task: '33333333-3333-4333-8333-333333333333',
  brief: '44444444-4444-4444-8444-444444444444',
  attempt: '55555555-5555-4555-8555-555555555555',
  causation: '66666666-6666-4666-8666-666666666666',
  worker: '77777777-7777-4777-8777-777777777777',
  verifier: '88888888-8888-4888-8888-888888888888',
  message: '99999999-9999-4999-8999-999999999999',
} as const;

const COMMON = {
  protocolVersion: 1,
  transitionRequestId: ID.request,
  projectId: ID.project,
  taskId: ID.task,
  taskBriefId: ID.brief,
  causationId: ID.causation,
  requestedAt: '2026-08-14T08:00:00.000Z',
};

const IDENTITY = {
  protocolVersion: COMMON.protocolVersion,
  transitionRequestId: COMMON.transitionRequestId,
  projectId: COMMON.projectId,
  taskId: COMMON.taskId,
  causationId: COMMON.causationId,
  requestedAt: COMMON.requestedAt,
};

const ATTEMPT_COMMON = { ...COMMON, assignmentAttemptId: ID.attempt };

const REQUESTS: Record<string, unknown>[] = [
  { ...COMMON, action: 'assign', workerAgentId: ID.worker, verifierAgentId: ID.verifier },
  { ...ATTEMPT_COMMON, action: 'start_work' },
  { ...ATTEMPT_COMMON, action: 'report_result', resultSummary: 'Bitti', evidenceRefs: [] },
  { ...ATTEMPT_COMMON, action: 'verifier_approved', verdictMessageId: ID.message },
  { ...ATTEMPT_COMMON, action: 'verifier_rejected', verdictMessageId: ID.message, reason: 'Test eksik' },
  { ...ATTEMPT_COMMON, action: 'gate_passed' },
  { ...ATTEMPT_COMMON, action: 'gate_failed', reason: 'Lint hatası', evidenceRefs: ['gate:1'] },
  { ...ATTEMPT_COMMON, action: 'commit_completed', commitHash: 'abc1234', artifactIds: [] },
  { ...ATTEMPT_COMMON, action: 'escalate', reason: 'Deneme sınırı', evidenceRefs: ['task:1'] },
  { ...ATTEMPT_COMMON, action: 'escalation_resolved' },
  { ...ATTEMPT_COMMON, action: 'request_user_input', questionMessageId: ID.message },
  { ...ATTEMPT_COMMON, action: 'user_answered' },
  { ...IDENTITY, action: 'cancel', fromStatus: 'queued', reason: 'Plan değişti' },
  { ...ATTEMPT_COMMON, action: 'fail', reason: 'Kurtarılamaz hata' },
];

describe('TaskTransitionRequestV1', () => {
  it('yalnız semantic ve typed transition taleplerini kabul eder', () => {
    expect(REQUESTS.map((request) => request['action'])).toEqual([...TASK_TRANSITION_ACTIONS]);
    for (const request of REQUESTS) {
      expect(TaskTransitionRequestV1Schema.safeParse(request).success).toBe(true);
    }
  });

  it('free-form status, bilinmeyen action ve unknown key reddeder', () => {
    expect(TaskTransitionRequestV1Schema.safeParse({
      ...COMMON,
      action: 'set_status',
      status: 'done',
    }).success).toBe(false);
    expect(TaskTransitionRequestV1Schema.safeParse({
      ...REQUESTS[1],
      status: 'done',
    }).success).toBe(false);
  });

  it.each([
    ['transitionRequestId', { ...REQUESTS[0], transitionRequestId: NIL_UUID }],
    ['projectId', { ...REQUESTS[0], projectId: NIL_UUID }],
    ['taskId', { ...REQUESTS[0], taskId: NIL_UUID }],
    ['taskBriefId', { ...REQUESTS[0], taskBriefId: NIL_UUID }],
    ['causationId', { ...REQUESTS[0], causationId: NIL_UUID }],
    ['workerAgentId', { ...REQUESTS[0], workerAgentId: NIL_UUID }],
    ['verifierAgentId', { ...REQUESTS[0], verifierAgentId: NIL_UUID }],
    ['assignmentAttemptId', { ...REQUESTS[1], assignmentAttemptId: NIL_UUID }],
    ['verdictMessageId', { ...REQUESTS[3], verdictMessageId: NIL_UUID }],
    ['questionMessageId', { ...REQUESTS[10], questionMessageId: NIL_UUID }],
    ['artifactIds', {
      ...REQUESTS[7],
      artifactIds: [NIL_UUID],
    }],
  ])('%s concrete kimliğinde nil UUID reddeder', (_field, request) => {
    expect(TaskTransitionRequestV1Schema.safeParse(request).success).toBe(false);
  });

  it('cancel dışındaki attempt-scope aksiyonlarında assignmentAttemptId zorunludur', () => {
    for (const request of REQUESTS.filter((item) =>
      item['action'] !== 'assign' && item['action'] !== 'cancel')) {
      const withoutAttempt = { ...request };
      delete withoutAttempt['assignmentAttemptId'];
      expect(TaskTransitionRequestV1Schema.safeParse(withoutAttempt).success).toBe(false);
    }
  });

  it('assign talebinde assignment attempt kimliğini reddeder', () => {
    expect(TaskTransitionRequestV1Schema.safeParse({
      ...REQUESTS[0],
      assignmentAttemptId: ID.attempt,
    }).success).toBe(false);
  });

  it('cancel talebinde pre-attempt veya tam attempt scope kimliğini kabul eder', () => {
    expect(TaskTransitionRequestV1Schema.safeParse({
      ...IDENTITY,
      action: 'cancel',
      fromStatus: 'queued',
      reason: 'İptal',
    }).success).toBe(true);
    expect(TaskTransitionRequestV1Schema.safeParse({
      ...ATTEMPT_COMMON,
      action: 'cancel',
      fromStatus: 'working',
      reason: 'İptal',
    }).success).toBe(true);
  });

  it('cancel scope kimliklerini çift olarak zorlar', () => {
    expect(TaskTransitionRequestV1Schema.safeParse({
      ...IDENTITY,
      taskBriefId: ID.brief,
      action: 'cancel',
      fromStatus: 'queued',
      reason: 'İptal',
    }).success).toBe(false);
    expect(TaskTransitionRequestV1Schema.safeParse({
      ...IDENTITY,
      assignmentAttemptId: ID.attempt,
      action: 'cancel',
      fromStatus: 'queued',
      reason: 'İptal',
    }).success).toBe(false);

    const withoutBrief = {
      ...ATTEMPT_COMMON,
      action: 'cancel',
      fromStatus: 'working',
      reason: 'İptal',
    };
    delete (withoutBrief as Partial<typeof withoutBrief>).taskBriefId;
    expect(TaskTransitionRequestV1Schema.safeParse(withoutBrief).success).toBe(false);

    const withoutAttempt = {
      ...ATTEMPT_COMMON,
      action: 'cancel',
      fromStatus: 'working',
      reason: 'İptal',
    };
    delete (withoutAttempt as Partial<typeof withoutAttempt>).assignmentAttemptId;
    expect(TaskTransitionRequestV1Schema.safeParse(withoutAttempt).success).toBe(false);
  });

  it('FSM edge kararını schedulera bırakıp her typed TaskStatus değerini taşır', () => {
    expect(TaskTransitionRequestV1Schema.safeParse({
      ...IDENTITY,
      action: 'cancel',
      fromStatus: 'done',
      reason: 'Scheduler karar verecek',
    }).success).toBe(true);
    expect(TaskTransitionRequestV1Schema.safeParse({
      ...ATTEMPT_COMMON,
      action: 'cancel',
      fromStatus: 'cancelled',
      reason: 'Scheduler karar verecek',
    }).success).toBe(true);
    expect(TaskTransitionRequestV1Schema.safeParse({
      ...IDENTITY,
      action: 'cancel',
      fromStatus: 'unknown',
      reason: 'Geçersiz durum',
    }).success).toBe(false);
  });
});
