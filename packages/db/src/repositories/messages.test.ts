import { randomUUID } from 'node:crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import { NIL_UUID, canonicalJsonV1, canonicalSha256V1, type AgentMessageEnvelopeV1 } from '@ww/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCh } from '../client.js';
import { runMigrations } from '../migrate.js';
import { clickhouseUp } from '../testutil.js';
import {
  appendMessage,
  findMessageByIdempotencyKey,
  getMessage,
  listMessagesBySession,
  listPendingInboxMessages,
} from './messages.js';
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
