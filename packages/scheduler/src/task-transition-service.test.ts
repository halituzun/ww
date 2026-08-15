import { randomUUID } from 'node:crypto';
import { NIL_UUID, SYSTEM_SENTINEL, TASK_STATUSES, TASK_TRANSITION_ACTIONS } from '@ww/shared';
import { describe, expect, it } from 'vitest';
import type { TaskRow } from '@ww/db';
import { evaluateTaskTransition } from './task-transition-service.js';

const projectId = randomUUID();
const taskId = randomUUID();
const briefId = randomUUID();
const attemptId = randomUUID();
const workerId = randomUUID();
const verifierId = randomUUID();
const causationId = randomUUID();

function task(status: TaskRow['status'], attempt = 0, maxAttempts = 3): TaskRow {
  return {
    task_id: taskId,
    project_id: projectId,
    plan_id: randomUUID(),
    parent_task_id: NIL_UUID,
    title: 'FSM',
    description: 'FSM test',
    status,
    priority: 5,
    issuer_agent_id: workerId,
    worker_agent_id: status === 'queued' ? NIL_UUID : workerId,
    verifier_agent_id: status === 'queued' ? NIL_UUID : verifierId,
    group: 'coding',
    depends_on: [],
    target_files: [],
    attempt,
    max_attempts: maxAttempts,
    delegation_depth: 0,
    token_budget: 100,
    tokens_spent: '0',
    commit_hash: '',
    result_summary: '',
    reject_reason: '',
    task_brief_id: status === 'queued' ? NIL_UUID : briefId,
    assignment_attempt_id: status === 'queued' ? NIL_UUID : attemptId,
    created_at: '2026-08-14T10:00:00.000Z',
    updated_at: '2026-08-14T10:00:00.000Z',
    version: '1',
  };
}

const system = {
  principalType: 'system' as const,
  principalId: SYSTEM_SENTINEL,
  serviceName: 'scheduler-test',
  authenticatedAt: '2026-08-14T10:00:00.000Z',
};

function request(action: (typeof TASK_TRANSITION_ACTIONS)[number], status: TaskRow['status']) {
  const identity = {
    protocolVersion: 1 as const,
    transitionRequestId: randomUUID(),
    projectId,
    taskId,
    causationId,
    requestedAt: '2026-08-14T10:01:00.000Z',
  };
  const common = { ...identity, taskBriefId: briefId, assignmentAttemptId: attemptId };
  switch (action) {
    case 'assign': return { ...identity, taskBriefId: briefId, action, workerAgentId: workerId, verifierAgentId: verifierId };
    case 'start_work': case 'gate_passed': case 'escalation_resolved': case 'user_answered':
      return { ...common, action };
    case 'report_result': return { ...common, action, resultSummary: 'done', evidenceRefs: [] };
    case 'verifier_approved': return { ...common, action, verdictMessageId: randomUUID() };
    case 'verifier_rejected': return { ...common, action, verdictMessageId: randomUUID(), reason: 'reject' };
    case 'gate_failed': return { ...common, action, reason: 'gate', evidenceRefs: [] };
    case 'commit_completed': return { ...common, action, commitHash: 'abcdef1', artifactIds: [] };
    case 'escalate': return { ...common, action, reason: 'brake', evidenceRefs: [] };
    case 'request_user_input': return { ...common, action, questionMessageId: randomUUID() };
    case 'cancel': return status === 'queued'
      ? { ...identity, action, fromStatus: status, reason: 'cancel' }
      : { ...common, action, fromStatus: status, reason: 'cancel' };
    case 'fail': return { ...common, action, reason: 'fatal' };
  }
}

const allowed = new Set([
  'queued:assign', 'queued:cancel', 'assigned:start_work',
  'working:report_result', 'working:fail', 'working:request_user_input',
  'verifying:verifier_approved', 'verifying:verifier_rejected',
  'testing:gate_passed', 'testing:gate_failed',
  'approved:commit_completed', 'escalated:escalation_resolved',
  'escalated:request_user_input', 'waiting_user:user_answered',
]);

describe('task FSM policy', () => {
  it('izinli butun edge ve illegal status/action capraz carpimini tek tablodan degerlendirir', () => {
    for (const status of TASK_STATUSES) {
      for (const action of TASK_TRANSITION_ACTIONS) {
        const result = evaluateTaskTransition(task(status), system, request(action, status));
        expect(result.decision.allowed, `${status}:${action}`).toBe(allowed.has(`${status}:${action}`));
        expect(result.decision.ruleId, `${status}:${action}`).toBe('TASK-001');
      }
    }
  });

  it('reject ve gate correction limitini ucuncu denemede escalated yapar', () => {
    expect(evaluateTaskTransition(
      task('verifying', 1, 3), system, request('verifier_rejected', 'verifying'),
    ).toStatus).toBe('working');
    expect(evaluateTaskTransition(
      task('verifying', 2, 3), system, request('verifier_rejected', 'verifying'),
    ).toStatus).toBe('escalated');
    expect(evaluateTaskTransition(
      task('testing', 2, 3), system, request('gate_failed', 'testing'),
    ).toStatus).toBe('escalated');
    expect(evaluateTaskTransition(
      task('waiting_user', 3, 3), system, request('user_answered', 'waiting_user'),
    ).toStatus).toBe('escalated');
  });

  it('sahte worker/verifier, stale brief-attempt ve cancel fromStatus fail-closed olur', () => {
    const worker = {
      principalType: 'agent' as const,
      principalId: randomUUID(),
      role: 'worker' as const,
      agentVersion: 1,
      authenticatedAt: system.authenticatedAt,
    };
    expect(evaluateTaskTransition(
      task('working'), worker, request('report_result', 'working'),
    ).decision.ruleId).toBe('TASK-002');
    expect(evaluateTaskTransition(
      task('working'), system, { ...request('report_result', 'working'), assignmentAttemptId: randomUUID() },
    ).decision.ruleId).toBe('TASK-003');
    expect(evaluateTaskTransition(
      task('queued'), system, { ...request('cancel', 'queued'), fromStatus: 'working' },
    ).decision.ruleId).toBe('TASK-003');
  });
});
