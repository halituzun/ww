import { randomUUID } from 'node:crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import { NIL_UUID, canonicalJsonV1, canonicalSha256V1, type AgentMessageEnvelopeV1 } from '@ww/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCh } from '../client.js';
import { runMigrations } from '../migrate.js';
import { clickhouseUp } from '../testutil.js';
import {
  appendMessage,
  findAuthoritativeAnswerWinner,
  findMessageByIdempotencyKey,
  getMessage,
  listDueInboxItems,
  listMessagesBySession,
  listPendingInboxMessages,
  listProtocolV1AnswerRepliesToMessage,
  listProtocolV1RepliesToMessage,
} from './messages.js';
import { appendEffectVersion, reserveEffect } from './effects.js';
import { appendReceiptVersion, createReceipt } from './receipts.js';
import {
  RepositoryConflictError,
  RepositoryWriteError,
  StoredRecordError,
  type AcknowledgedWriteVerificationCause,
  type UncertainWriteCause,
} from './types.js';

const up = await clickhouseUp();

function throwAfterAcceptedInsert(ch: ClickHouseClient): ClickHouseClient {
  let thrown = false;
  return {
    query: ch.query.bind(ch),
    insert: async (options: Parameters<ClickHouseClient['insert']>[0]) => {
      await ch.insert(options);
      if (!thrown) {
        thrown = true;
        throw new Error('simulated timeout after accepted insert');
      }
    },
  } as unknown as ClickHouseClient;
}

describe('messages uncertain write boundary', () => {
  it.each(['read-error', 'empty-read'] as const)(
    'insert sonrasi %s sonucunda insert nedenini typed olarak korur',
    async (mode) => {
      const insert = new Error('insert timeout');
      const reconciliation = new Error('message reread unavailable');
      let queryCount = 0;
      const client = {
        query: async () => {
          queryCount += 1;
          if (queryCount === 1) return { json: async () => [] };
          if (mode === 'read-error') throw reconciliation;
          return { json: async () => [] };
        },
        insert: async () => { throw insert; },
      } as unknown as ClickHouseClient;
      const senderId = randomUUID();
      const input = {
        protocolVersion: 1 as const,
        messageId: randomUUID(),
        projectId: randomUUID(),
        sessionId: randomUUID(),
        senderPrincipalId: senderId,
        authenticatedPrincipal: {
          principalType: 'agent' as const,
          principalId: senderId,
          role: 'worker' as const,
          agentVersion: 1,
          authenticatedAt: '2026-08-14T10:00:00.000Z',
        },
        recipient: { type: 'agent' as const, id: randomUUID() },
        kind: 'question' as const,
        payload: { type: 'question' as const, text: 'Need a decision' },
        correlationId: randomUUID(),
        idempotencyKey: `message-${randomUUID()}`,
        provenance: { class: 'system_generated' as const },
        priority: 'normal' as const,
        createdAt: '2026-08-14T10:00:00.000Z',
      } satisfies AgentMessageEnvelopeV1;

      await expect(appendMessage(client, { envelope: input })).rejects.toSatisfy((error: unknown) => {
        if (!(error instanceof RepositoryWriteError)) return false;
        const cause = error.cause as UncertainWriteCause;
        return cause.insert === insert && (
          mode === 'read-error'
            ? cause.reconciliation === reconciliation
            : cause.reconciliation === undefined
        );
      });
    },
  );
});

describe.skipIf(!up)('messages repository', () => {
  const db = `ww_test_messages_${Date.now()}_${process.pid}`;
  let ch: ClickHouseClient;

  beforeAll(async () => {
    await runMigrations({ database: db });
    ch = createCh({ database: db });
  });

  afterAll(async () => {
    const admin = createCh({ database: 'default' });
    await admin.command({ query: `DROP DATABASE IF EXISTS ${db}` });
    await admin.close();
    await ch.close();
  });

  function envelope(overrides: Partial<AgentMessageEnvelopeV1> = {}): AgentMessageEnvelopeV1 {
    const senderId = randomUUID();
    return {
      protocolVersion: 1,
      messageId: randomUUID(),
      projectId: randomUUID(),
      sessionId: randomUUID(),
      senderPrincipalId: senderId,
      authenticatedPrincipal: {
        principalType: 'agent',
        principalId: senderId,
        role: 'worker',
        agentVersion: 1,
        authenticatedAt: '2026-08-14T14:59:00+03:00',
      },
      recipient: { type: 'agent', id: randomUUID() },
      kind: 'question',
      payload: { type: 'question', text: 'Need a decision' },
      correlationId: randomUUID(),
      idempotencyKey: `message-${randomUUID()}`,
      provenance: { class: 'system_generated' },
      priority: 'normal',
      createdAt: '2026-08-14T15:00:00+03:00',
      deadlineAt: '2026-08-14T16:00:00+03:00',
      ...overrides,
    };
  }

  function legacyRow(input: AgentMessageEnvelopeV1, content = 'legacy') {
    return {
      message_id: input.messageId,
      project_id: input.projectId,
      session_id: input.sessionId,
      from_agent_id: input.senderPrincipalId,
      to_agent_id: input.recipient.id,
      kind: input.kind,
      content,
      model_ref: 'mock:legacy',
      created_at: input.createdAt,
    };
  }

  function protocolV1Row(input: AgentMessageEnvelopeV1) {
    if (input.payload.type !== 'question') throw new Error('question payload bekleniyordu');
    return {
      ...legacyRow(input, input.payload.text),
      model_ref: 'mock:v1',
      protocol_version: 1,
      payload_version: 1,
      payload_json: canonicalJsonV1(input.payload),
      payload_hash: canonicalSha256V1(input.payload),
      envelope_hash: canonicalSha256V1(input),
      reply_to_message_id: NIL_UUID,
      correlation_id: input.correlationId,
      causation_id: NIL_UUID,
      idempotency_key: input.idempotencyKey,
      task_brief_id: NIL_UUID,
      assignment_attempt_id: NIL_UUID,
      invocation_id: NIL_UUID,
      prompt_input_snapshot_id: NIL_UUID,
      deadline_at: input.deadlineAt,
      priority: input.priority,
      authenticated_principal_json: canonicalJsonV1(input.authenticatedPrincipal),
      provenance_json: canonicalJsonV1(input.provenance),
    };
  }

  it('protocol v1 mesajını UTC normalize eder, hashleri doğrular ve uncertain inserti uzlaştırır', async () => {
    const input = envelope();
    const written = await appendMessage(throwAfterAcceptedInsert(ch), {
      envelope: input,
      actualModelRef: 'mock:used-model',
    });

    expect(written.envelope.createdAt).toBe('2026-08-14T12:00:00.000Z');
    expect(written.envelope.deadlineAt).toBe('2026-08-14T13:00:00.000Z');
    expect(written.actualModelRef).toBe('mock:used-model');
    expect(written.payloadHash).toBe(canonicalSha256V1(written.envelope.payload));
    expect(written.envelopeHash).toBe(canonicalSha256V1(written.envelope));
    expect(await appendMessage(ch, { envelope: input, actualModelRef: 'mock:used-model' }))
      .toEqual(written);
    expect(await listMessagesBySession(ch, input.projectId, input.sessionId)).toEqual([written]);
  });

  it('idempotency key ve deterministic message id çakışmalarını fail-closed ayırır', async () => {
    const original = envelope();
    await appendMessage(ch, { envelope: original, actualModelRef: 'mock:used-a' });

    await expect(appendMessage(ch, {
      envelope: original,
      actualModelRef: 'mock:used-b',
    })).rejects.toBeInstanceOf(RepositoryConflictError);

    await expect(appendMessage(ch, {
      envelope: envelope({
        projectId: original.projectId,
        sessionId: original.sessionId,
        idempotencyKey: original.idempotencyKey,
      }),
    })).rejects.toBeInstanceOf(RepositoryConflictError);

    await expect(appendMessage(ch, {
      envelope: envelope({
        messageId: original.messageId,
        projectId: original.projectId,
        sessionId: original.sessionId,
      }),
    })).rejects.toBeInstanceOf(RepositoryConflictError);
  });

  it('exact retry her iki namespacei uzlaştırır ve benign duplicate kabul eder', async () => {
    const normalizedTimes = {
      createdAt: '2026-08-14T12:00:00.000Z',
      deadlineAt: '2026-08-14T13:00:00.000Z',
    } as const;
    const original = envelope(normalizedTimes);
    await appendMessage(ch, { envelope: original, actualModelRef: 'mock:v1' });
    const divergentOwner = envelope({
      ...normalizedTimes,
      projectId: original.projectId,
      sessionId: original.sessionId,
      idempotencyKey: original.idempotencyKey,
    });
    await ch.insert({
      table: 'messages',
      values: [protocolV1Row(divergentOwner)],
      format: 'JSONEachRow',
    });

    await expect(appendMessage(ch, {
      envelope: original,
      actualModelRef: 'mock:v1',
    })).rejects.toBeInstanceOf(RepositoryConflictError);

    const duplicate = envelope(normalizedTimes);
    const written = await appendMessage(ch, { envelope: duplicate, actualModelRef: 'mock:v1' });
    await ch.insert({
      table: 'messages',
      values: [protocolV1Row(duplicate)],
      format: 'JSONEachRow',
    });
    expect(await appendMessage(ch, { envelope: duplicate, actualModelRef: 'mock:v1' }))
      .toEqual(written);
    expect(await getMessage(ch, duplicate.projectId, duplicate.messageId)).toEqual(written);
    expect(await findMessageByIdempotencyKey(ch, duplicate.projectId, duplicate.idempotencyKey))
      .toEqual(written);
    expect(await listMessagesBySession(ch, duplicate.projectId, duplicate.sessionId))
      .toEqual([written]);
  });

  it('append namespace sahipligini tek snapshotta okuyarak aradaki pencereyi kapatir', async () => {
    const normalizedTimes = {
      createdAt: '2026-08-14T12:00:00.000Z',
      deadlineAt: '2026-08-14T13:00:00.000Z',
    } as const;
    const original = envelope(normalizedTimes);
    await appendMessage(ch, { envelope: original, actualModelRef: 'mock:v1' });
    const divergent = envelope({
      ...normalizedTimes,
      messageId: original.messageId,
      projectId: original.projectId,
      sessionId: original.sessionId,
    });
    let injected = false;
    const atomic = new Proxy(ch, {
      get(target, property) {
        if (property === 'query') return async (options: Parameters<ClickHouseClient['query']>[0]) => {
          const query = String(options.query);
          if (!injected && (
            query.includes('(message_id = {messageId:UUID} OR idempotency_key') ||
            query.includes('AND idempotency_key = {idempotencyKey:String}')
          )) {
            injected = true;
            await target.insert({
              table: 'messages',
              values: [protocolV1Row(divergent)],
              format: 'JSONEachRow',
            });
          }
          return target.query(options);
        };
        const member: unknown = Reflect.get(target, property, target);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });

    await expect(appendMessage(atomic, {
      envelope: original,
      actualModelRef: 'mock:v1',
    })).rejects.toBeInstanceOf(RepositoryConflictError);
    expect(injected).toBe(true);
  });

  it('partial namespace divergenceini uncertain veya acknowledged write olarak gizlemez', async () => {
    for (const mode of ['uncertain', 'acknowledged'] as const) {
      const normalizedTimes = {
        createdAt: '2026-08-14T12:00:00.000Z',
        deadlineAt: '2026-08-14T13:00:00.000Z',
      } as const;
      const original = envelope(normalizedTimes);
      const divergent = envelope({
        ...normalizedTimes,
        messageId: original.messageId,
        projectId: original.projectId,
        sessionId: original.sessionId,
      });
      const partial = new Proxy(ch, {
        get(target, property) {
          if (property === 'insert') return async () => {
            await target.insert({
              table: 'messages',
              values: [protocolV1Row(divergent)],
              format: 'JSONEachRow',
            });
            if (mode === 'uncertain') throw new Error('simulated partial insert timeout');
          };
          const member: unknown = Reflect.get(target, property, target);
          return typeof member === 'function' ? member.bind(target) : member;
        },
      });

      await expect(appendMessage(partial, {
        envelope: original,
        actualModelRef: 'mock:v1',
      })).rejects.toBeInstanceOf(RepositoryConflictError);
    }
  });

  it('public readers stable idempotency owner catismasini fail-closed tutar', async () => {
    const normalizedTimes = {
      createdAt: '2026-08-14T12:00:00.000Z',
      deadlineAt: '2026-08-14T13:00:00.000Z',
    } as const;
    const original = envelope(normalizedTimes);
    await appendMessage(ch, { envelope: original, actualModelRef: 'mock:v1' });
    const divergentOwner = envelope({
      ...normalizedTimes,
      projectId: original.projectId,
      idempotencyKey: original.idempotencyKey,
    });
    await ch.insert({
      table: 'messages',
      values: [protocolV1Row(divergentOwner)],
      format: 'JSONEachRow',
    });
    await createReceipt(ch, {
      receipt_id: randomUUID(),
      message_id: original.messageId,
      project_id: original.projectId,
      recipient_id: original.recipient.id,
      recipient_snapshot: original.recipient,
      state: 'enqueued',
      claim_owner: '',
      claim_fence: '0',
      retry_count: 0,
      error: '',
      created_at: normalizedTimes.createdAt,
    });

    await expect(findMessageByIdempotencyKey(
      ch,
      original.projectId,
      original.idempotencyKey,
    )).rejects.toBeInstanceOf(RepositoryConflictError);
    await expect(getMessage(ch, original.projectId, original.messageId))
      .rejects.toBeInstanceOf(RepositoryConflictError);
    await expect(listMessagesBySession(ch, original.projectId, original.sessionId))
      .rejects.toBeInstanceOf(RepositoryConflictError);
    await expect(listPendingInboxMessages(ch, original.projectId, original.recipient.id))
      .rejects.toBeInstanceOf(RepositoryConflictError);
    await expect(listDueInboxItems(ch, {
      now: '2026-08-14T12:00:00.000Z',
      recipientId: original.recipient.id,
      limit: 10,
    })).rejects.toBeInstanceOf(RepositoryConflictError);
  });

  it('idempotency namespace cevabini bounded tutar ve asiri collisioni fail-closed reddeder', async () => {
    const projectId = randomUUID();
    const idempotencyKey = `bounded-${randomUUID()}`;
    await ch.insert({
      table: 'messages',
      values: Array.from({ length: 101 }, () => protocolV1Row(envelope({
        projectId,
        idempotencyKey,
        createdAt: '2026-08-14T12:00:00.000Z',
        deadlineAt: '2026-08-14T13:00:00.000Z',
      }))),
      format: 'JSONEachRow',
    });
    await expect(findMessageByIdempotencyKey(ch, projectId, idempotencyKey))
      .rejects.toBeInstanceOf(RepositoryConflictError);
  });

  it('idempotency indexi 50k multi-granule projectte exact primary-key pruning yapar', async () => {
    const projectId = randomUUID();
    const targetKey = 'message-key-025000';
    const rows = Array.from({ length: 50_001 }, (_, index) => protocolV1Row(envelope({
      projectId,
      idempotencyKey: `message-key-${String(index).padStart(6, '0')}`,
      createdAt: '2026-08-14T12:00:00.000Z',
      deadlineAt: '2026-08-14T13:00:00.000Z',
    })));
    await ch.insert({ table: 'messages', values: rows, format: 'JSONEachRow' });
    expect(await findMessageByIdempotencyKey(ch, projectId, targetKey))
      .toMatchObject({ protocolVersion: 1, envelope: { idempotencyKey: targetKey } });

    const explanation = await ch.query({
      query: `EXPLAIN indexes = 1
        SELECT message_id FROM idempotency_messages
        PREWHERE project_id = {projectId:UUID}
          AND idempotency_key = {idempotencyKey:String}
        LIMIT 101`,
      query_params: { projectId, idempotencyKey: targetKey },
      format: 'JSONEachRow',
    });
    const explainText = (await explanation.json<{ explain: string }>())
      .map((row) => row.explain)
      .join('\n');
    const granules = [...explainText.matchAll(/Granules: (\d+)\/(\d+)/g)]
      .map((match) => ({ selected: Number(match[1]), total: Number(match[2]) }));
    expect(granules.some(({ selected, total }) => total >= 6 && selected < total)).toBe(true);
  }, 30_000);

  it('replyTo sorgusu project scope icinde exact protocol-v1 cevaplarini dondurur', async () => {
    const projectId = randomUUID();
    const sessionId = randomUUID();
    const question = envelope({ projectId, sessionId });
    await appendMessage(ch, { envelope: question });
    const earlier = envelope({
      projectId,
      sessionId,
      kind: 'answer',
      payload: { type: 'answer', text: 'Earlier answer' },
      replyToMessageId: question.messageId,
      correlationId: question.correlationId,
      createdAt: '2026-08-14T12:01:00.000Z',
      deadlineAt: '2026-08-14T13:01:00.000Z',
    });
    const later = envelope({
      projectId,
      sessionId,
      kind: 'answer',
      payload: { type: 'answer', text: 'Later answer' },
      replyToMessageId: question.messageId,
      correlationId: question.correlationId,
      createdAt: '2026-08-14T12:02:00.000Z',
      deadlineAt: '2026-08-14T13:02:00.000Z',
    });
    const unrelated = envelope({
      projectId,
      sessionId,
      kind: 'answer',
      payload: { type: 'answer', text: 'Unrelated answer' },
      replyToMessageId: randomUUID(),
      createdAt: '2026-08-14T12:00:30.000Z',
      deadlineAt: '2026-08-14T13:00:30.000Z',
    });
    const otherProject = envelope({
      sessionId,
      kind: 'answer',
      payload: { type: 'answer', text: 'Other project answer' },
      replyToMessageId: question.messageId,
      createdAt: '2026-08-14T12:00:00.000Z',
      deadlineAt: '2026-08-14T13:00:00.000Z',
    });
    const earlierRecord = await appendMessage(ch, { envelope: earlier });
    const laterRecord = await appendMessage(ch, { envelope: later });
    await appendMessage(ch, { envelope: unrelated });
    await appendMessage(ch, { envelope: otherProject });

    expect(await listProtocolV1RepliesToMessage(ch, projectId, question.messageId))
      .toEqual([earlierRecord, laterRecord]);
  });

  it('authoritative answer yalniz durable winner effectinin exact answer mesajini sayar', async () => {
    const projectId = randomUUID();
    const sessionId = randomUUID();
    const question = envelope({ projectId, sessionId });
    await appendMessage(ch, { envelope: question });
    const unselectedAnswer = envelope({
      projectId,
      sessionId,
      kind: 'answer',
      payload: { type: 'answer', text: 'Stored but not selected' },
      replyToMessageId: question.messageId,
      correlationId: question.correlationId,
      createdAt: '2026-08-14T12:01:00.000Z',
      deadlineAt: '2026-08-14T13:01:00.000Z',
    });
    const unselectedRecord = await appendMessage(ch, { envelope: unselectedAnswer });
    expect(await listProtocolV1AnswerRepliesToMessage(ch, projectId, question.messageId))
      .toEqual([unselectedRecord]);
    expect(await findAuthoritativeAnswerWinner(ch, projectId, question.messageId)).toBeNull();

    const answer = envelope({
      projectId,
      sessionId,
      kind: 'answer',
      payload: { type: 'answer', text: 'Authoritative answer' },
      replyToMessageId: question.messageId,
      correlationId: question.correlationId,
      createdAt: '2026-08-14T12:02:00.000Z',
      deadlineAt: '2026-08-14T13:02:00.000Z',
    });
    const answerRecord = await appendMessage(ch, { envelope: answer });
    const pendingWinner = await reserveEffect(ch, {
      causation_id: question.messageId,
      stable_effect_id: 'question-answer-winner',
      project_id: projectId,
      effect_type: 'question_answer_selection_v1',
      request: { answerMessageId: answer.messageId },
      replay_safety: 'replay_safe',
      lease_fence: '1',
      created_at: answer.createdAt,
    });
    expect(await findAuthoritativeAnswerWinner(ch, projectId, question.messageId)).toBeNull();
    await appendEffectVersion(ch, {
      causation_id: question.messageId,
      stable_effect_id: 'question-answer-winner',
      expectedVersion: pendingWinner.effect_version,
      state: 'succeeded',
      result: { answerMessageId: answer.messageId },
      error: '',
      lease_fence: '1',
      created_at: answer.createdAt,
    });

    expect(await listProtocolV1AnswerRepliesToMessage(ch, projectId, question.messageId))
      .toEqual([unselectedRecord, answerRecord]);
    expect(await findAuthoritativeAnswerWinner(ch, projectId, question.messageId))
      .toEqual(answerRecord);
  });

  it('winner effect non-answer mesaji veya yanlis answer baglamini authoritative yapamaz', async () => {
    const projectId = randomUUID();
    const sessionId = randomUUID();
    const question = envelope({ projectId, sessionId });
    await appendMessage(ch, { envelope: question });
    const nonAnswer = envelope({
      projectId,
      sessionId,
      kind: 'question',
      payload: { type: 'question', text: 'Not an answer' },
    });
    await appendMessage(ch, { envelope: nonAnswer });
    const winner = await reserveEffect(ch, {
      causation_id: question.messageId,
      stable_effect_id: 'question-answer-winner',
      project_id: projectId,
      effect_type: 'question_answer_selection_v1',
      request: { answerMessageId: nonAnswer.messageId },
      replay_safety: 'replay_safe',
      lease_fence: '1',
      created_at: nonAnswer.createdAt,
    });
    await appendEffectVersion(ch, {
      causation_id: question.messageId,
      stable_effect_id: 'question-answer-winner',
      expectedVersion: winner.effect_version,
      state: 'succeeded',
      result: { answerMessageId: nonAnswer.messageId },
      error: '',
      lease_fence: '1',
      created_at: nonAnswer.createdAt,
    });
    await expect(findAuthoritativeAnswerWinner(ch, projectId, question.messageId))
      .rejects.toBeInstanceOf(StoredRecordError);
  });

  it('due inbox protocol-v1 mesaj ile latest receipt kaydini birlikte dondurur', async () => {
    const input = envelope();
    const message = await appendMessage(ch, { envelope: input });
    const receipt = await createReceipt(ch, {
      receipt_id: randomUUID(),
      message_id: input.messageId,
      project_id: input.projectId,
      recipient_id: input.recipient.id,
      recipient_snapshot: input.recipient,
      state: 'enqueued',
      claim_owner: '',
      claim_fence: '0',
      retry_count: 0,
      error: '',
      created_at: input.createdAt,
    });

    expect(await listDueInboxItems(ch, {
      now: input.createdAt,
      recipientId: input.recipient.id,
      limit: 10,
    })).toEqual([{ message, receipt }]);
  });

  it('receipt state fold edildikten sonra yalnız pending inbox mesajlarını döndürür', async () => {
    const input = envelope();
    const message = await appendMessage(ch, { envelope: input });
    const now = '2026-08-14T12:00:00.000Z';
    const receipt = await createReceipt(ch, {
      receipt_id: randomUUID(),
      message_id: input.messageId,
      project_id: input.projectId,
      recipient_id: input.recipient.id,
      recipient_snapshot: input.recipient,
      state: 'enqueued',
      claim_owner: '',
      claim_fence: '0',
      retry_count: 0,
      error: '',
      created_at: now,
    });
    expect(await listPendingInboxMessages(ch, input.projectId, input.recipient.id))
      .toEqual([message]);

    await appendReceiptVersion(ch, {
      expectedVersion: receipt.receipt_version,
      next: { ...receipt, state: 'processed' },
    });
    expect(await listPendingInboxMessages(ch, input.projectId, input.recipient.id)).toEqual([]);
  });

  it('pending receipt eksik message referansini sessizce dusurmez', async () => {
    const input = envelope();
    await createReceipt(ch, {
      receipt_id: randomUUID(),
      message_id: input.messageId,
      project_id: input.projectId,
      recipient_id: input.recipient.id,
      recipient_snapshot: input.recipient,
      state: 'enqueued',
      claim_owner: '',
      claim_fence: '0',
      retry_count: 0,
      error: '',
      created_at: input.createdAt,
    });

    await expect(listPendingInboxMessages(ch, input.projectId, input.recipient.id))
      .rejects.toBeInstanceOf(StoredRecordError);
    await expect(listDueInboxItems(ch, {
      now: input.createdAt,
      recipientId: input.recipient.id,
      limit: 10,
    })).rejects.toBeInstanceOf(StoredRecordError);
  });

  it('protocol 0 satırını yalnız açık legacy projection olarak döndürür', async () => {
    const projectId = randomUUID();
    const messageId = randomUUID();
    const sessionId = randomUUID();
    const agentId = randomUUID();
    await ch.insert({
      table: 'messages',
      values: [{
        message_id: messageId,
        project_id: projectId,
        session_id: sessionId,
        from_agent_id: agentId,
        to_agent_id: agentId,
        kind: 'question',
        content: 'legacy',
        model_ref: 'mock:legacy',
        created_at: '2026-08-14T12:00:00.000Z',
      }],
      format: 'JSONEachRow',
    });
    const record = await getMessage(ch, projectId, messageId);
    expect(record).toMatchObject({ protocolVersion: 0, content: 'legacy', taskId: NIL_UUID });
    expect(record).not.toHaveProperty('envelope');

    await createReceipt(ch, {
      receipt_id: randomUUID(),
      message_id: messageId,
      project_id: projectId,
      recipient_id: agentId,
      recipient_snapshot: { type: 'agent', id: agentId },
      state: 'enqueued',
      claim_owner: '',
      claim_fence: '0',
      retry_count: 0,
      error: '',
      created_at: '2026-08-14T12:00:00.000Z',
    });
    await expect(listDueInboxItems(ch, {
      now: '2026-08-14T12:00:00.000Z',
      recipientId: agentId,
      limit: 10,
    })).rejects.toBeInstanceOf(StoredRecordError);
  });

  it('legacy retry kopyalarını uzlaştırır, divergent ve mixed protocol kimliklerini sıra bağımsız reddeder', async () => {
    const legacy = envelope({
      createdAt: '2026-08-14T12:00:00.000Z',
      deadlineAt: '2026-08-14T13:00:00.000Z',
    });
    const identical = legacyRow(legacy);
    await ch.insert({ table: 'messages', values: [identical, identical], format: 'JSONEachRow' });
    expect(await getMessage(ch, legacy.projectId, legacy.messageId))
      .toMatchObject({ protocolVersion: 0, content: 'legacy' });

    await ch.insert({
      table: 'messages',
      values: [legacyRow(legacy, 'divergent legacy')],
      format: 'JSONEachRow',
    });
    await expect(getMessage(ch, legacy.projectId, legacy.messageId))
      .rejects.toBeInstanceOf(RepositoryConflictError);

    for (const protocolOrder of ['legacy-first', 'v1-first'] as const) {
      const mixed = envelope({
        createdAt: '2026-08-14T12:00:00.000Z',
        deadlineAt: '2026-08-14T13:00:00.000Z',
      });
      const ordered = protocolOrder === 'legacy-first'
        ? [legacyRow(mixed), protocolV1Row(mixed)]
        : [protocolV1Row(mixed), legacyRow(mixed)];
      await ch.insert({ table: 'messages', values: ordered, format: 'JSONEachRow' });
      await expect(getMessage(ch, mixed.projectId, mixed.messageId))
        .rejects.toBeInstanceOf(RepositoryConflictError);
    }
  });

  it('bozuk protocol v1 payload JSON kaydını domain mesajı olarak sızdırmaz', async () => {
    const input = envelope();
    await ch.insert({
      table: 'messages',
      values: [{
        message_id: input.messageId,
        project_id: input.projectId,
        session_id: input.sessionId,
        task_id: NIL_UUID,
        from_agent_id: input.senderPrincipalId,
        to_agent_id: input.recipient.id,
        kind: input.kind,
        content: 'broken',
        model_ref: '',
        created_at: input.createdAt,
        protocol_version: 1,
        payload_version: 1,
        payload_json: '{bad-json',
        payload_hash: canonicalSha256V1(input.payload),
        envelope_hash: canonicalSha256V1(input),
        reply_to_message_id: NIL_UUID,
        correlation_id: input.correlationId,
        causation_id: NIL_UUID,
        idempotency_key: input.idempotencyKey,
        task_brief_id: NIL_UUID,
        assignment_attempt_id: NIL_UUID,
        invocation_id: NIL_UUID,
        prompt_input_snapshot_id: NIL_UUID,
        deadline_at: input.deadlineAt,
        priority: input.priority,
        authenticated_principal_json: canonicalJsonV1(input.authenticatedPrincipal),
        provenance_json: canonicalJsonV1(input.provenance),
      }],
      format: 'JSONEachRow',
    });
    await expect(getMessage(ch, input.projectId, input.messageId))
      .rejects.toBeInstanceOf(StoredRecordError);
  });

  it('protocol v1 content projeksiyon tamperini reddeder ve duplicate divergencei conflict yapar', async () => {
    const normalizedTimes = {
      createdAt: '2026-08-14T12:00:00.000Z',
      deadlineAt: '2026-08-14T13:00:00.000Z',
    } as const;
    const single = envelope(normalizedTimes);
    await ch.insert({
      table: 'messages',
      values: [{ ...protocolV1Row(single), content: 'tampered projection' }],
      format: 'JSONEachRow',
    });
    await expect(getMessage(ch, single.projectId, single.messageId))
      .rejects.toBeInstanceOf(StoredRecordError);

    for (const field of ['content', 'model_ref'] as const) {
      const input = envelope(normalizedTimes);
      const stored = protocolV1Row(input);
      const divergent = field === 'content'
        ? { ...stored, content: 'tampered duplicate' }
        : { ...stored, model_ref: 'mock:other-used-model' };
      await ch.insert({
        table: 'messages',
        values: [stored, divergent],
        format: 'JSONEachRow',
      });
      await expect(getMessage(ch, input.projectId, input.messageId))
        .rejects.toBeInstanceOf(RepositoryConflictError);
    }
  });

  it('message post-ack read hatasini typed verir ve exact retry tam projectioni uzlastirir', async () => {
    const input = envelope();
    const actualModelRef = 'mock:actual-used-model';
    const verification = new Error('message verification unavailable');
    let failNextQuery = false;
    const acknowledged = new Proxy(ch, {
      get(target, property) {
        if (property === 'insert') return async (options: Parameters<ClickHouseClient['insert']>[0]) => {
          await target.insert(options);
          failNextQuery = true;
        };
        if (property === 'query') return (options: Parameters<ClickHouseClient['query']>[0]) => {
          if (failNextQuery) {
            failNextQuery = false;
            throw verification;
          }
          return target.query(options);
        };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const failure = await appendMessage(acknowledged, {
      envelope: input,
      actualModelRef,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RepositoryWriteError);
    const cause = (failure as RepositoryWriteError).cause as AcknowledgedWriteVerificationCause;
    expect(cause).toMatchObject({ commitLikely: true, verification });

    const retried = await appendMessage(ch, { envelope: input, actualModelRef });
    expect(retried.actualModelRef).toBe(actualModelRef);
    expect(retried.content).toBe('Need a decision');
  });
});
