// Worker ve verifier araç portları (docs/03 → roller, docs/05 → araçlar).
//
// Worker yazar, verifier YALNIZ okur. Bu ayrım denetimin temelidir: verifier
// denetlediği kodu değiştirebilseydi bağımsız denetim diye bir şey kalmazdı.
import { executorToolRegistry } from '@ww/executor';
import type { AssignmentAttemptV1, EntityId, JsonValue, TaskBriefV1 } from '@ww/shared';

export interface ToolDefinitionLike {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCallLike {
  callId: EntityId;
  name: string;
  args: unknown;
  occurredAt: string;
}

export interface ToolExecutorLike {
  /** Bağlam ZORUNLU: izinli araçlar brief ve role göre süzülür. */
  definitions(context: Record<string, unknown>): readonly ToolDefinitionLike[];
  execute(context: Record<string, unknown>, call: ToolCallLike): Promise<JsonValue>;
}

/**
 * Araç argümanı doğrulaması ARAÇ KAYDINDA yaşar. Fabrika bir zamanlar
 * `executor.validate(...)` çağırıyordu — böyle bir metot hiç yoktu ve HER
 * araç çağrısı "validate is not a function" ile düşüyordu.
 */
function validateToolArgs(name: string, args: unknown): unknown {
  return executorToolRegistry.parseArguments(name as never, args);
}

export interface ToolPortLike {
  definitions(): readonly ToolDefinitionLike[];
  validate(name: string, args: unknown): unknown;
  execute(call: ToolCallLike): Promise<JsonValue>;
}

export interface ToolFactoryInput {
  executor: ToolExecutorLike;
  effectEscalation: { sessionId: EntityId; owningPmId: EntityId };
}

export interface ToolScope {
  brief: TaskBriefV1;
  attempt: AssignmentAttemptV1;
  workspaceRoot: string;
}

/** Verifier'ın kullanabileceği araçlar; yazma ve komut çalıştırma yoktur. */
export const VERIFIER_READONLY_TOOLS: readonly string[] = [
  'read_file',
  'git_diff',
  'submit_verdict',
];

export function createToolPortFactory(input: ToolFactoryInput) {
  const contextFor = (scope: ToolScope, role: 'worker' | 'verifier') => ({
    workspaceRoot: scope.workspaceRoot,
    agentId: role === 'worker'
      ? (scope.attempt as unknown as { workerAgentId: EntityId }).workerAgentId
      : (scope.attempt as unknown as { verifierAgentId: EntityId }).verifierAgentId,
    agentRole: role,
    taskStatus: role === 'worker' ? 'working' : 'verifying',
    brief: scope.brief,
    attempt: scope.attempt,
    effectEscalation: input.effectEscalation,
  });

  const allowedByBrief = (scope: ToolScope): readonly string[] =>
    (scope.brief as unknown as { allowedTools: readonly string[] }).allowedTools;

  return {
    forWorker(scope: ToolScope): ToolPortLike {
      const allowed = allowedByBrief(scope);
      return {
        definitions: () => input.executor.definitions(contextFor(scope, 'worker'))
          .filter((definition) => allowed.includes(definition.name)),
        // Doğrulama araç kaydındadır; executor'da böyle bir metot YOK.
        validate: (name, args) => validateToolArgs(name, args),
        execute: (call) => input.executor.execute(contextFor(scope, 'worker'), call),
      };
    },

    forVerifier(scope: ToolScope): ToolPortLike {
      const allowed = allowedByBrief(scope)
        .filter((name) => VERIFIER_READONLY_TOOLS.includes(name));
      return {
        definitions: () => input.executor.definitions(contextFor(scope, 'verifier'))
          .filter((definition) => allowed.includes(definition.name)),
        validate: (name, args) => validateToolArgs(name, args),
        execute: async (call) => {
          // Sınır BURADA uygulanır: yazma çağrısı executor'a hiç ulaşmaz,
          // yoksa denetim kaydına yetkisiz bir deneme düşer ve kafa karıştırır.
          if (!VERIFIER_READONLY_TOOLS.includes(call.name)) {
            throw new Error(`verifier salt-okuma sınırını aşamaz: ${call.name}`);
          }
          return input.executor.execute(contextFor(scope, 'verifier'), call);
        },
      };
    },
  };
}
