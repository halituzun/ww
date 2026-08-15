import type {
  AssignmentAttemptV1,
  EntityId,
  TaskStatus,
} from '@ww/shared';
import type { Phase1SchedulerPort } from './phase1-orchestrator.js';

/**
 * Production composition boundary for Phase 1 orchestration.
 *
 * The injected operations are the already-constructed AssignmentService,
 * TaskTransitionService, GateRunner and GitWorkspace adapters. This package
 * owns no repository writes here; FSM, fences, durable effects and commit
 * evidence remain owned by those services.
 */
export type SchedulerOrchestrationOperations = Phase1SchedulerPort;

export class SchedulerOrchestrationPortAdapter implements Phase1SchedulerPort {
  readonly #operations: SchedulerOrchestrationOperations;

  constructor(operations: SchedulerOrchestrationOperations) {
    const required = ['assign', 'awaitUserAnswer', 'resumeUserAnswer', 'handleExecutionError', 'transition', 'reassign', 'escalate', 'gate', 'commit'] as const;
    for (const method of required) {
      if (typeof operations[method] !== 'function') {
        throw new Error(`scheduler orchestration operation eksik: ${method}`);
      }
    }
    this.#operations = operations;
  }

  assign(taskId: EntityId): Promise<AssignmentAttemptV1> { return this.#operations.assign(taskId); }
  awaitUserAnswer(input: Parameters<Phase1SchedulerPort['awaitUserAnswer']>[0]): Promise<void> { return this.#operations.awaitUserAnswer(input); }
  resumeUserAnswer(input: Parameters<Phase1SchedulerPort['resumeUserAnswer']>[0]): Promise<AssignmentAttemptV1> { return this.#operations.resumeUserAnswer(input); }
  handleExecutionError(input: Parameters<Phase1SchedulerPort['handleExecutionError']>[0]): Promise<TaskStatus> { return this.#operations.handleExecutionError(input); }
  transition(input: Parameters<Phase1SchedulerPort['transition']>[0]): ReturnType<Phase1SchedulerPort['transition']> { return this.#operations.transition(input); }
  reassign(input: Parameters<Phase1SchedulerPort['reassign']>[0]): Promise<AssignmentAttemptV1> { return this.#operations.reassign(input); }
  escalate(input: Parameters<Phase1SchedulerPort['escalate']>[0]): Promise<void> { return this.#operations.escalate(input); }
  gate(input: Parameters<Phase1SchedulerPort['gate']>[0]): ReturnType<Phase1SchedulerPort['gate']> { return this.#operations.gate(input); }
  commit(input: Parameters<Phase1SchedulerPort['commit']>[0]): ReturnType<Phase1SchedulerPort['commit']> { return this.#operations.commit(input); }
}

export type SchedulerOrchestrationPort = Phase1SchedulerPort;
