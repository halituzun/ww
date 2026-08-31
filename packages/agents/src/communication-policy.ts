import { NIL_UUID, type MessageKind, type PolicyDecision } from '@ww/shared';
import type { AgentRow, TaskRow } from '@ww/db';
import type { AuthenticatedPrincipalV1, PartyRefV1, SendMessageInputV1 } from '@ww/shared';

const RULE_VERSION = 1;

export interface CommunicationPolicyContext {
  readonly principal: AuthenticatedPrincipalV1;
  readonly input: SendMessageInputV1;
  readonly senderAgent?: AgentRow;
  readonly recipientAgent?: AgentRow;
  readonly task?: TaskRow;
  readonly broadcastRecipients?: readonly AgentRow[];
  readonly answerTargetValid?: boolean;
}

function result(
  ruleId: PolicyDecision['ruleId'],
  allowed: boolean,
  reason: string,
  evidenceRefs: readonly string[],
): PolicyDecision {
  return Object.freeze({ ruleId, ruleVersion: RULE_VERSION, allowed, reason, evidenceRefs });
}

function denied(reason: string, context: CommunicationPolicyContext): PolicyDecision {
  return result('COMM-002', false, reason, [
    `principal:${context.principal.principalId}`,
    `recipient:${context.input.recipient.id}`,
    `kind:${context.input.kind}`,
  ]);
}

function recipientIsAgentRole(
  recipient: PartyRefV1,
  agent: AgentRow | undefined,
  role: AgentRow['role'],
): boolean {
  return recipient.type === 'agent' &&
    agent?.agent_id === recipient.id &&
    agent.role === role &&
    agent.status !== 'stopped';
}

function taskOwnsSender(task: TaskRow | undefined, principalId: string, kind: MessageKind): boolean {
  if (task === undefined) return false;
  if (kind === 'report' || kind === 'question') return task.worker_agent_id === principalId;
  if (kind === 'verdict') return task.verifier_agent_id === principalId;
  return true;
}

function taskOwnsRecipient(task: TaskRow | undefined, recipientId: string, kind: MessageKind): boolean {
  if (task === undefined) return false;
  if (kind === 'report') return task.verifier_agent_id === recipientId;
  if (kind === 'verdict' || kind === 'order') return task.worker_agent_id === recipientId;
  return true;
}

function pmOwnsWorker(pmId: string, worker: AgentRow, task: TaskRow | undefined): boolean {
  return worker.parent_agent_id === pmId ||
    (
      task !== undefined &&
      task.issuer_agent_id === pmId &&
      task.worker_agent_id === worker.agent_id
    );
}

function sameGroup(sender: AgentRow | undefined, recipient: AgentRow | undefined): boolean {
  return sender !== undefined && recipient !== undefined && sender.group === recipient.group;
}

/** Exact Faz 1 route matrix. Unlisted roles, kinds, and Phase 4 routes fail closed. */
export function evaluateCommunicationPolicy(
  context: CommunicationPolicyContext,
): PolicyDecision {
  const { principal, input, recipientAgent, senderAgent, task } = context;

  if (principal.principalType === 'system') {
    if (
      input.kind === 'escalation' &&
      recipientIsAgentRole(input.recipient, recipientAgent, 'pm') &&
      (task === undefined || task.issuer_agent_id === recipientAgent!.agent_id)
    ) {
      return result('COMM-006', true, 'code-owned escalation owning PM alicisina izinli', [
        `recipient:${recipientAgent!.agent_id}`,
        ...(task === undefined ? [] : [`task:${task.task_id}`]),
      ]);
    }
    return denied('Faz 1 routing matrisinde system gonderici rotasi yoktur', context);
  }

  if (principal.principalType === 'user') {
    if (input.kind === 'user_command' && recipientIsAgentRole(input.recipient, recipientAgent, 'pm')) {
      return result('COMM-002', true, 'kullanici komutu PM alicisina izinli', [
        `recipient:${input.recipient.id}`,
      ]);
    }
    if (
      input.kind === 'answer' &&
      input.recipient.type === 'agent' &&
      recipientAgent?.agent_id === input.recipient.id &&
      recipientAgent.status !== 'stopped' &&
      context.answerTargetValid === true
    ) {
      return result('COMM-004', true, 'kullanici cevabi tek pending sorunun sahibine bagli', [
        `reply:${input.replyToMessageId ?? 'missing'}`,
      ]);
    }
    if (input.kind === 'answer') {
      return result(
        'COMM-004',
        false,
        'kullanici cevabi exact, cevapsiz question kimligiyle eslesmiyor',
        [`reply:${input.replyToMessageId ?? 'missing'}`],
      );
    }
    return denied('kullanici yalniz PM user_command veya exact pending question answer gonderebilir', context);
  }

  if (principal.role === 'worker' && input.kind === 'question') {
    const recipientOwnsWorker = task !== undefined && recipientAgent !== undefined && (
      task.issuer_agent_id === recipientAgent.agent_id ||
      senderAgent?.parent_agent_id === recipientAgent.agent_id
    );
    if (
      recipientIsAgentRole(input.recipient, recipientAgent, 'pm') &&
      taskOwnsSender(task, principal.principalId, input.kind) &&
      recipientOwnsWorker
    ) {
      return result('COMM-002', true, 'atanmis worker sorusu PM alicisina izinli', [
        `task:${task?.task_id ?? NIL_UUID}`,
      ]);
    }
    return denied(
      'worker question yalniz gorev issuer veya worker parent PM alicisina gidebilir',
      context,
    );
  }

  if (principal.role === 'worker' && input.kind === 'report') {
    const assigned = taskOwnsSender(task, principal.principalId, input.kind);
    const recipientAllowed = input.recipient.type === 'system' || (
      recipientIsAgentRole(input.recipient, recipientAgent, 'verifier') &&
      taskOwnsRecipient(task, input.recipient.id, input.kind)
    );
    if (assigned && recipientAllowed) {
      return result('COMM-002', true, 'atanmis worker report rotasina izinli', [
        `task:${task?.task_id ?? NIL_UUID}`,
      ]);
    }
    return denied('worker report yalniz atanmis verifier veya scheduler alicisina gidebilir', context);
  }

  if (principal.role === 'verifier' && input.kind === 'verdict') {
    const assigned = taskOwnsSender(task, principal.principalId, input.kind);
    const recipientAllowed = input.recipient.type === 'system' || (
      recipientIsAgentRole(input.recipient, recipientAgent, 'worker') &&
      taskOwnsRecipient(task, input.recipient.id, input.kind)
    );
    if (assigned && recipientAllowed) {
      return result('COMM-002', true, 'atanmis verifier verdict rotasina izinli', [
        `task:${task?.task_id ?? NIL_UUID}`,
      ]);
    }
    return denied('verifier verdict yalniz atanmis worker veya scheduler alicisina gidebilir', context);
  }

  if (input.kind === 'proposal' || input.kind === 'objection' || input.kind === 'synthesis') {
    const isCouncilTurn = input.provenance?.class === 'agent_message' && typeof input.provenance?.sourceId === 'string' && input.provenance.sourceId.startsWith('turn-');
    if (isCouncilTurn && input.recipient.type === 'agent' && recipientAgent !== undefined && recipientAgent.status !== 'stopped') {
      return result('COMM-002', true, 'konsey müzakeresi turu oturum üyeleri arasında izinli', [
        `recipient:${recipientAgent.agent_id}`,
      ]);
    }
    if (principal.role === 'professor' && (input.kind === 'synthesis' || input.kind === 'objection')) {
      if (recipientIsAgentRole(input.recipient, recipientAgent, 'pm')) {
        return result('COMM-002', true, 'professor synthesis veya objection PM alicisina izinli', [
          `recipient:${recipientAgent!.agent_id}`,
        ]);
      }
      return denied('professor synthesis/objection yalniz PM alicisina gidebilir', context);
    }
    return denied('konsey mesaji yalniz aktif turn veya professor->PM rotasina izinli', context);
  }

  if (principal.role === 'group_lead' && input.kind === 'order') {
    if (recipientIsAgentRole(input.recipient, recipientAgent, 'worker') && sameGroup(senderAgent, recipientAgent) && (task === undefined || task.worker_agent_id === recipientAgent!.agent_id)) {
      return result('COMM-002', true, 'group lead kendi grubundaki worker a order gonderebilir', [`recipient:${recipientAgent!.agent_id}`]);
    }
    return denied('group lead order yalniz kendi grubundaki worker a gidebilir', context);
  }

  if (principal.role === 'group_lead' && input.kind === 'escalation') {
    if (recipientIsAgentRole(input.recipient, recipientAgent, 'professor') || recipientIsAgentRole(input.recipient, recipientAgent, 'pm')) {
      return result('COMM-006', true, 'group lead unresolved escalation zincirine izinli', [`recipient:${input.recipient.id}`]);
    }
    return denied('group lead escalation professor veya PM alicisina gidebilir', context);
  }



  if (principal.role === 'interviewer' && input.kind === 'question') {
    if (recipientIsAgentRole(input.recipient, recipientAgent, 'pm')) {
      return result('COMM-002', true, 'interviewer gereksinim sorusu PM alicisina izinli', [`recipient:${recipientAgent!.agent_id}`]);
    }
    return denied('interviewer sorusu PM alicisina gidebilir', context);
  }

  if (principal.role === 'pm' && input.kind === 'order') {
    if (
      recipientIsAgentRole(input.recipient, recipientAgent, 'worker') &&
      pmOwnsWorker(principal.principalId, recipientAgent!, task) &&
      (task === undefined || taskOwnsRecipient(task, input.recipient.id, input.kind))
    ) {
      return result('COMM-002', true, 'PM kendi kapsamindaki worker icin order gonderebilir', [
        `recipient:${input.recipient.id}`,
      ]);
    }
    if (
      input.recipient.type === 'broadcast' &&
      context.broadcastRecipients !== undefined &&
      context.broadcastRecipients.length > 0 &&
      context.broadcastRecipients.every((worker) => (
        worker.role === 'worker' &&
        worker.status !== 'stopped' &&
        pmOwnsWorker(principal.principalId, worker, task) &&
        (task === undefined || task.worker_agent_id === worker.agent_id)
      ))
    ) {
      return result('COMM-005', true, 'PM order broadcast alici snapshotu kendi kapsamiyla sinirli',
        context.broadcastRecipients.map((worker) => `recipient:${worker.agent_id}`));
    }
    return denied('PM order yalniz kendi kapsamindaki worker alicilarina gidebilir', context);
  }

  return denied('gonderen/recipient/kind kombinasyonu Faz 1 matrisinde tanimli degildir', context);
}
