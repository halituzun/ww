import { describe, expect, it } from 'vitest';
import {
  BROADCAST_SENTINEL,
  MESSAGE_KINDS,
  NIL_UUID,
  SYSTEM_SENTINEL,
  USER_SENTINEL,
} from './constants.js';
import {
  AgentMessageEnvelopeV1Schema,
  ProvenanceV1Schema,
  SendMessageInputV1Schema,
  parseAgentMessageEnvelopeV1,
} from './communication.js';
import { canonicalJsonV1, canonicalSha256V1 } from './json.js';

const ID = {
  agent: '11111111-1111-4111-8111-111111111111',
  recipient: '22222222-2222-4222-8222-222222222222',
  project: '33333333-3333-4333-8333-333333333333',
  session: '44444444-4444-4444-8444-444444444444',
  message: '55555555-5555-4555-8555-555555555555',
  task: '66666666-6666-4666-8666-666666666666',
  brief: '77777777-7777-4777-8777-777777777777',
  attempt: '88888888-8888-4888-8888-888888888888',
  correlation: '99999999-9999-4999-8999-999999999999',
  reply: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  invocation: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  promptSnapshot: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
} as const;

const VERDICT = {
  decision: 'reject',
  reasons: [{
    message: 'Eksik test eklenmeli',
    evidenceRefs: ['diff:1'],
    rule: { ruleId: 'TASK-001', ruleVersion: 1 },
  }],
  evidenceRefs: ['diff:1'],
  ruleRefs: [{ ruleId: 'TASK-001', ruleVersion: 1 }],
};

const PAYLOADS: Record<string, unknown>[] = [
  { type: 'question', text: 'Hangi davranış bekleniyor?' },
  { type: 'answer', text: 'Belgelenen davranışı uygula.' },
  { type: 'order', instruction: 'Testi ekle.' },
  { type: 'proposal', markdown: '## Öneri' },
  { type: 'objection', markdown: 'Risk var.', evidenceRefs: ['plan:1'] },
  { type: 'synthesis', markdown: '## Sentez' },
  { type: 'report', summary: 'Değişiklik tamamlandı.', evidenceRefs: ['commit:abc'] },
  { type: 'escalation', reason: 'Bütçe kararı gerekli.', evidenceRefs: ['task:1'] },
  { type: 'user_command', text: 'Bu görevi önceliklendir.' },
  { type: 'verdict', verdict: VERDICT },
];

function validEnvelope(payload: Record<string, unknown>): Record<string, unknown> {
  const kind = payload['type'];
  return {
    protocolVersion: 1,
    messageId: ID.message,
    projectId: ID.project,
    sessionId: ID.session,
    taskId: ID.task,
    taskBriefId: ID.brief,
    assignmentAttemptId: ID.attempt,
    senderPrincipalId: ID.agent,
    authenticatedPrincipal: {
      principalType: 'agent',
      principalId: ID.agent,
      role: 'worker',
      agentVersion: 1,
      authenticatedAt: '2026-08-14T08:00:00.000Z',
    },
    recipient: { type: 'agent', id: ID.recipient },
    kind,
    payload,
    ...(kind === 'answer' ? { replyToMessageId: ID.reply } : {}),
    ...((kind === 'report' || kind === 'verdict') ? {
      invocationId: ID.invocation,
      promptInputSnapshotId: ID.promptSnapshot,
    } : {}),
    correlationId: ID.correlation,
    idempotencyKey: `send:${String(kind)}`,
    provenance: { class: 'agent_message', sourceId: ID.agent },
    priority: 'normal',
    createdAt: '2026-08-14T08:00:00.000Z',
    deadlineAt: '2026-08-14T09:00:00.000Z',
  };
}

function validSendInput(payload: Record<string, unknown>): Record<string, unknown> {
  const envelope = validEnvelope(payload);
  const {
    protocolVersion: _protocolVersion,
    messageId: _messageId,
    senderPrincipalId: _senderPrincipalId,
    authenticatedPrincipal: _authenticatedPrincipal,
    ...input
  } = envelope;
  void _protocolVersion;
  void _messageId;
  void _senderPrincipalId;
  void _authenticatedPrincipal;
  return input;
}

describe('AgentMessageEnvelopeV1', () => {
  it('on payload varyantını canonical JSON üzerinden round-trip eder', () => {
    expect(PAYLOADS.map((payload) => payload['type'])).toEqual([...MESSAGE_KINDS]);

    for (const payload of PAYLOADS) {
      const parsed = parseAgentMessageEnvelopeV1(validEnvelope(payload));
      const canonical = canonicalJsonV1(parsed);
      expect(parseAgentMessageEnvelopeV1(JSON.parse(canonical))).toEqual(parsed);
      expect(canonicalSha256V1(JSON.parse(canonical))).toBe(canonicalSha256V1(parsed));
    }
  });

  it.each([
    ['bilinmeyen protocol', { protocolVersion: 2 }],
    ['bozuk UUID', { messageId: 'mesaj' }],
    ['bozuk zaman', { createdAt: 'dün' }],
  ])('%s değerini fail-closed reddeder', (_name, patch) => {
    expect(AgentMessageEnvelopeV1Schema.safeParse({
      ...validEnvelope(PAYLOADS[0]!),
      ...patch,
    }).success).toBe(false);
  });

  it.each([
    ['messageId', (value: Record<string, unknown>) => ({ ...value, messageId: NIL_UUID })],
    ['projectId', (value: Record<string, unknown>) => ({ ...value, projectId: NIL_UUID })],
    ['sessionId', (value: Record<string, unknown>) => ({ ...value, sessionId: NIL_UUID })],
    ['taskId', (value: Record<string, unknown>) => ({ ...value, taskId: NIL_UUID })],
    ['taskBriefId', (value: Record<string, unknown>) => ({ ...value, taskBriefId: NIL_UUID })],
    ['assignmentAttemptId', (value: Record<string, unknown>) => ({
      ...value,
      assignmentAttemptId: NIL_UUID,
    })],
    ['senderPrincipalId', (value: Record<string, unknown>) => ({
      ...value,
      senderPrincipalId: NIL_UUID,
    })],
    ['authenticatedPrincipal.principalId', (value: Record<string, unknown>) => ({
      ...value,
      authenticatedPrincipal: {
        ...(value['authenticatedPrincipal'] as Record<string, unknown>),
        principalId: NIL_UUID,
      },
    })],
    ['recipient.id', (value: Record<string, unknown>) => ({
      ...value,
      recipient: { type: 'agent', id: NIL_UUID },
    })],
    ['replyToMessageId', (value: Record<string, unknown>) => ({
      ...value,
      replyToMessageId: NIL_UUID,
    })],
    ['correlationId', (value: Record<string, unknown>) => ({ ...value, correlationId: NIL_UUID })],
    ['causationId', (value: Record<string, unknown>) => ({ ...value, causationId: NIL_UUID })],
    ['invocationId', (value: Record<string, unknown>) => ({ ...value, invocationId: NIL_UUID })],
    ['promptInputSnapshotId', (value: Record<string, unknown>) => ({
      ...value,
      promptInputSnapshotId: NIL_UUID,
    })],
  ])('%s concrete kimliğinde nil UUID reddeder', (_field, patch) => {
    expect(AgentMessageEnvelopeV1Schema.safeParse(
      patch(validEnvelope(PAYLOADS[1]!)),
    ).success).toBe(false);
  });

  it('bilinmeyen üst ve payload alanlarını reddeder', () => {
    expect(AgentMessageEnvelopeV1Schema.safeParse({
      ...validEnvelope(PAYLOADS[0]!),
      surprise: true,
    }).success).toBe(false);
    expect(AgentMessageEnvelopeV1Schema.safeParse(validEnvelope({
      type: 'question',
      text: 'Soru',
      surprise: true,
    })).success).toBe(false);
  });

  it('bilinmeyen payload türünü ve principal rolünü reddeder', () => {
    expect(AgentMessageEnvelopeV1Schema.safeParse({
      ...validEnvelope({ type: 'future_message', text: 'Bilinmeyen payload' }),
      kind: 'question',
    }).success).toBe(false);
    const unknownRole = validEnvelope(PAYLOADS[0]!);
    unknownRole['authenticatedPrincipal'] = {
      ...(unknownRole['authenticatedPrincipal'] as Record<string, unknown>),
      role: 'supervisor',
    };
    expect(AgentMessageEnvelopeV1Schema.safeParse(unknownRole).success).toBe(false);
  });

  it('kind/payload uyuşmazlığı, repliesiz answer ve answer dışı reply alanını reddeder', () => {
    expect(AgentMessageEnvelopeV1Schema.safeParse({
      ...validEnvelope(PAYLOADS[0]!),
      kind: 'order',
    }).success).toBe(false);
    const answer = validEnvelope(PAYLOADS[1]!);
    delete answer['replyToMessageId'];
    expect(AgentMessageEnvelopeV1Schema.safeParse(answer).success).toBe(false);
    expect(AgentMessageEnvelopeV1Schema.safeParse({
      ...validEnvelope(PAYLOADS[2]!),
      replyToMessageId: ID.reply,
    }).success).toBe(false);
    for (const nonAnswer of [PAYLOADS[2]!, PAYLOADS[8]!]) {
      expect(SendMessageInputV1Schema.safeParse({
        ...validSendInput(nonAnswer),
        replyToMessageId: ID.reply,
      }).success).toBe(false);
    }
  });

  it('report/verdict task referansları ve yapılandırılmış verdict gerektirir', () => {
    const report = validEnvelope(PAYLOADS[6]!);
    delete report['taskBriefId'];
    expect(AgentMessageEnvelopeV1Schema.safeParse(report).success).toBe(false);
    const missingInvocation = validEnvelope(PAYLOADS[6]!);
    delete missingInvocation['invocationId'];
    expect(AgentMessageEnvelopeV1Schema.safeParse(missingInvocation).success).toBe(false);
    expect(AgentMessageEnvelopeV1Schema.safeParse(validEnvelope({
      type: 'verdict',
      verdict: { decision: 'reject', reasons: 'serbest metin' },
    })).success).toBe(false);
  });

  it('deadline ve doğrulanmış principal bütünlüğünü zorlar', () => {
    expect(AgentMessageEnvelopeV1Schema.safeParse({
      ...validEnvelope(PAYLOADS[0]!),
      deadlineAt: '2026-08-14T07:59:59.000Z',
    }).success).toBe(false);
    expect(AgentMessageEnvelopeV1Schema.safeParse({
      ...validEnvelope(PAYLOADS[0]!),
      senderPrincipalId: ID.recipient,
    }).success).toBe(false);
  });

  it('sender, reply ve correlation UUID değerlerini karşılaştırmadan önce kanonikleştirir', () => {
    const canonical = ID.reply;
    const uppercase = canonical.toUpperCase();
    const envelope = validEnvelope(PAYLOADS[1]!);
    const parsed = AgentMessageEnvelopeV1Schema.parse({
      ...envelope,
      senderPrincipalId: uppercase,
      authenticatedPrincipal: {
        ...(envelope['authenticatedPrincipal'] as Record<string, unknown>),
        principalId: canonical,
      },
      replyToMessageId: uppercase,
      correlationId: uppercase,
    });

    expect(parsed.senderPrincipalId).toBe(canonical);
    expect(parsed.authenticatedPrincipal.principalId).toBe(canonical);
    expect(parsed.replyToMessageId).toBe(canonical);
    expect(parsed.correlationId).toBe(canonical);
  });

  it('provenance source kimliğinde opaque case değerini koruyup strict UUID kanonikleştirir', () => {
    expect(ProvenanceV1Schema.parse({
      class: 'agent_message',
      sourceId: ' Role.Worker.Coding ',
    }).sourceId).toBe('Role.Worker.Coding');
    expect(ProvenanceV1Schema.parse({
      class: 'agent_message',
      sourceId: ID.reply.toUpperCase(),
    }).sourceId).toBe(ID.reply);
  });

  it.each([
    ['nil', NIL_UUID],
    ['user sentinel', USER_SENTINEL],
    ['system sentinel', SYSTEM_SENTINEL],
    ['broadcast sentinel', BROADCAST_SENTINEL],
    ['z.guid-only UUID görünümü', '11111111-1111-0111-8111-111111111111'],
  ])('provenance sourceId alanında %s değerini reddeder', (_name, sourceId) => {
    expect(ProvenanceV1Schema.safeParse({
      class: 'agent_message',
      sourceId,
    }).success).toBe(false);
  });

  it('broadcast alıcısını yalnız doğrulanmış PM veya sisteme açar', () => {
    const broadcast = {
      ...validEnvelope(PAYLOADS[2]!),
      recipient: { type: 'broadcast', id: BROADCAST_SENTINEL },
    };
    expect(AgentMessageEnvelopeV1Schema.safeParse(broadcast).success).toBe(false);
    expect(AgentMessageEnvelopeV1Schema.safeParse({
      ...broadcast,
      senderPrincipalId: SYSTEM_SENTINEL,
      authenticatedPrincipal: {
        principalType: 'system',
        principalId: SYSTEM_SENTINEL,
        serviceName: 'scheduler',
        authenticatedAt: '2026-08-14T08:00:00.000Z',
      },
    }).success).toBe(true);
  });

  it('SendMessageInput sender rolü veya kimliği kabul etmez', () => {
    const envelope = validEnvelope(PAYLOADS[0]!);
    const input = {
      projectId: envelope['projectId'],
      sessionId: envelope['sessionId'],
      taskId: envelope['taskId'],
      taskBriefId: envelope['taskBriefId'],
      assignmentAttemptId: envelope['assignmentAttemptId'],
      recipient: envelope['recipient'],
      kind: envelope['kind'],
      payload: envelope['payload'],
      idempotencyKey: envelope['idempotencyKey'],
      provenance: envelope['provenance'],
      priority: envelope['priority'],
      createdAt: envelope['createdAt'],
    };
    expect(SendMessageInputV1Schema.safeParse(input).success).toBe(true);
    expect(SendMessageInputV1Schema.safeParse({ ...input, senderRole: 'pm' }).success).toBe(false);
    expect(SendMessageInputV1Schema.safeParse({ ...input, senderPrincipalId: ID.agent }).success).toBe(false);
  });

});
