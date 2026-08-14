import { randomUUID } from 'node:crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import {
  BROADCAST_SENTINEL,
  type AgentMessageEnvelopeV1,
  type PartyRefV1,
} from '@ww/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCh } from './client.js';
import { runMigrations } from './migrate.js';
import {
  COMMUNICATION_WAKEUP_CHANNEL,
  CommunicationWakeupPublisher,
  type DurableCommunicationWrite,
} from './redis-wakeup.js';
import type { WwRedis } from './redis.js';
import { appendMessage, listPendingInboxMessages } from './repositories/messages.js';
import { createReceipt } from './repositories/receipts.js';
import { clickhouseUp } from './testutil.js';

const chUp = await clickhouseUp();

function redisWithPublish(
  publish: WwRedis['publish'],
  connect: () => Promise<void> = async () => undefined,
): WwRedis {
  const duplicate = vi.fn(() => {
    let open = false;
    const scoped = { publish } as unknown as WwRedis;
    const client = {
      get isOpen() { return open; },
      on: vi.fn(),
      connect: vi.fn(async () => {
        await connect();
        open = true;
        return client;
      }),
      withAbortSignal: vi.fn(() => scoped),
      destroy: vi.fn(() => { open = false; }),
    } as unknown as WwRedis;
    return client;
  });
  return {
    duplicate,
  } as unknown as WwRedis;
}

async function withUnhandledRejectionCapture(work: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', listener);
  try {
    await work();
    await new Promise<void>((resolve) => setImmediate(resolve));
    return unhandled;
  } finally {
    process.removeListener('unhandledRejection', listener);
  }
}

function pointerWrite(
  declaredRecipient: PartyRefV1 = { type: 'agent', id: randomUUID() },
): DurableCommunicationWrite {
  const messageId = randomUUID();
  const projectId = randomUUID();
  const recipient = declaredRecipient.type === 'broadcast'
    ? { type: 'agent' as const, id: randomUUID() }
    : declaredRecipient;
  return {
    message: { messageId, projectId, recipient: declaredRecipient },
    receipts: [{
      messageId,
      projectId,
      recipientId: recipient.id,
      recipient,
      state: 'enqueued',
    }],
  };
}

function broadcastWrite(recipientCount: number): DurableCommunicationWrite {
  const input = pointerWrite({ type: 'broadcast', id: BROADCAST_SENTINEL });
  const first = input.receipts[0]!;
  return {
    ...input,
    receipts: Array.from({ length: recipientCount }, (_unused, index) => {
      if (index === 0) return first;
      const recipient = { type: 'agent' as const, id: randomUUID() };
      return {
        ...first,
        recipientId: recipient.id,
        recipient,
      };
    }),
  };
}

describe('CommunicationWakeupPublisher pointer siniri', () => {
  it('yalniz messageId, recipient ve projectId alanlarini yayinlar', async () => {
    const publish = vi.fn(async () => 2);
    const redis = redisWithPublish(publish as WwRedis['publish']);
    const input = pointerWrite();

    const result = await new CommunicationWakeupPublisher(redis)
      .publishAfterDurableWrite(input);

    expect(result).toEqual([{
      messageId: input.message.messageId,
      projectId: input.message.projectId,
      recipient: input.receipts[0]!.recipient,
      published: true,
      receiverCount: 2,
    }]);
    expect(publish).toHaveBeenCalledOnce();
    const [channel, json] = publish.mock.calls[0]!;
    expect(channel).toBe(COMMUNICATION_WAKEUP_CHANNEL);
    expect(JSON.parse(json)).toEqual({
      messageId: input.message.messageId,
      recipient: input.receipts[0]!.recipient,
      projectId: input.message.projectId,
    });
    expect(Object.keys(JSON.parse(json)).sort()).toEqual([
      'messageId',
      'projectId',
      'recipient',
    ]);
    expect(redis.duplicate).toHaveBeenCalledOnce();
    const dedicated = (redis.duplicate as ReturnType<typeof vi.fn>)
      .mock.results[0]!.value as WwRedis;
    expect(dedicated.destroy).toHaveBeenCalledOnce();
  });

  it('publish hatasini best-effort sonucuna cevirir ve durable pointeri kaybetmez', async () => {
    const failure = new Error('Redis unavailable');
    const publish = vi.fn(async () => { throw failure; });
    const redis = redisWithPublish(publish as WwRedis['publish']);
    const onPublishError = vi.fn();
    const input = pointerWrite();

    const result = await new CommunicationWakeupPublisher(redis, { onPublishError })
      .publishAfterDurableWrite(input);

    expect(result).toEqual([{
      messageId: input.message.messageId,
      projectId: input.message.projectId,
      recipient: input.receipts[0]!.recipient,
      published: false,
      receiverCount: 0,
    }]);
    expect(onPublishError).toHaveBeenCalledWith(failure, {
      messageId: input.message.messageId,
      projectId: input.message.projectId,
      recipient: input.receipts[0]!.recipient,
    });
  });

  it('hata gozlem callbacki firlatsa bile durable-first sonucu reject etmez', async () => {
    const input = pointerWrite();
    const publish = vi.fn(async () => { throw new Error('Redis unavailable'); });
    const redis = redisWithPublish(publish as WwRedis['publish']);
    const publisher = new CommunicationWakeupPublisher(redis, {
      onPublishError: () => { throw new Error('observer failed'); },
    });

    await expect(publisher.publishAfterDurableWrite(input)).resolves.toMatchObject([
      { published: false, receiverCount: 0 },
    ]);
  });

  it('async observer rejectionini beklemez, unhandled veya secret sizintisi uretmez', async () => {
    const observerSecret = 'observer-secret-token';
    const publish = vi.fn(async () => { throw new Error('Redis unavailable'); });
    const redis = redisWithPublish(publish as WwRedis['publish']);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let observerCall = 0;
    const onPublishError = vi.fn((): Promise<void> => {
      observerCall += 1;
      if (observerCall === 1) return new Promise<void>(() => undefined);
      return Promise.reject(new Error(observerSecret));
    });
    try {
      let result: Awaited<ReturnType<CommunicationWakeupPublisher['publishAfterDurableWrite']>> = [];
      const startedAt = Date.now();
      const unhandled = await withUnhandledRejectionCapture(async () => {
        result = await new CommunicationWakeupPublisher(redis, { onPublishError })
          .publishAfterDurableWrite(broadcastWrite(2));
      });
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(unhandled).toEqual([]);
      expect(result).toMatchObject([
        { published: false, receiverCount: 0 },
        { published: false, receiverCount: 0 },
      ]);
      expect(JSON.stringify(result)).not.toContain(observerSecret);
      expect(consoleError).not.toHaveBeenCalled();
      expect(onPublishError).toHaveBeenCalledTimes(2);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('uc recipient blackholeunu tek toplam deadline ile keser ve sonraki cagriyi kurtarir', async () => {
    const publish = vi.fn()
      .mockImplementationOnce(() => new Promise<number>(() => undefined))
      .mockResolvedValueOnce(1);
    const redis = redisWithPublish(publish as WwRedis['publish']);
    const onPublishError = vi.fn();
    const startedAt = Date.now();
    const publisher = new CommunicationWakeupPublisher(redis, {
      publishTimeoutMs: 25,
      onPublishError,
    });

    const result = await publisher.publishAfterDurableWrite(broadcastWrite(3));

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(result).toHaveLength(3);
    expect(result.every((entry) => !entry.published && entry.receiverCount === 0)).toBe(true);
    expect(onPublishError).toHaveBeenCalledTimes(3);
    expect(onPublishError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/25 ms/) }),
      expect.any(Object),
    );
    expect(publish).toHaveBeenCalledOnce();
    expect(redis.duplicate).toHaveBeenCalledOnce();
    const firstClient = (redis.duplicate as ReturnType<typeof vi.fn>)
      .mock.results[0]!.value as WwRedis;
    expect(firstClient.destroy).toHaveBeenCalledOnce();

    await expect(publisher.publishAfterDurableWrite(pointerWrite())).resolves.toMatchObject([
      { published: true, receiverCount: 1 },
    ]);
    expect(redis.duplicate).toHaveBeenCalledTimes(2);
    const secondClient = (redis.duplicate as ReturnType<typeof vi.fn>)
      .mock.results[1]!.value as WwRedis;
    expect(secondClient).not.toBe(firstClient);
    expect(secondClient.destroy).toHaveBeenCalledOnce();
  });

  it('connect failureda hic publish etmez ve disposable clienti tam bir kez yok eder', async () => {
    const publish = vi.fn(async () => 1);
    const redis = redisWithPublish(
      publish as WwRedis['publish'],
      async () => { throw new Error('connect failed'); },
    );
    await expect(new CommunicationWakeupPublisher(redis, {
      onPublishError: () => undefined,
    }).publishAfterDurableWrite(broadcastWrite(3))).resolves.toMatchObject([
      { published: false },
      { published: false },
      { published: false },
    ]);
    expect(publish).not.toHaveBeenCalled();
    const dedicated = (redis.duplicate as ReturnType<typeof vi.fn>)
      .mock.results[0]!.value as WwRedis;
    expect(dedicated.destroy).toHaveBeenCalledOnce();
  });

  it('pre-abort Redis isi baslatmaz ve timeout sinirini dogrular', async () => {
    const publish = vi.fn(() => Promise.reject(new Error('pre-abort publish')));
    const redis = redisWithPublish(publish as WwRedis['publish']);
    const controller = new AbortController();
    const publisher = new CommunicationWakeupPublisher(redis, {
      publishTimeoutMs: 1_000,
      signal: controller.signal,
      onPublishError: () => undefined,
    });
    controller.abort(new Error('operator cancelled'));

    const unhandled = await withUnhandledRejectionCapture(async () => {
      await expect(publisher.publishAfterDurableWrite(pointerWrite())).resolves.toMatchObject([
        { published: false, receiverCount: 0 },
      ]);
    });
    expect(unhandled).toEqual([]);
    expect(redis.duplicate).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(() => new CommunicationWakeupPublisher(redis, { publishTimeoutMs: 0 }))
      .toThrow(/publishTimeoutMs/);
    expect(() => new CommunicationWakeupPublisher(redis, { publishTimeoutMs: 5_001 }))
      .toThrow(/publishTimeoutMs/);
  });

  it('publish Promise.reject ile abort ayni anda olursa unhandled rejection sizdirmaz', async () => {
    const controller = new AbortController();
    const publish = vi.fn(() => {
      controller.abort();
      return Promise.reject(new Error('publish rejected during abort'));
    });
    const redis = redisWithPublish(publish as WwRedis['publish']);
    const publisher = new CommunicationWakeupPublisher(redis, {
      signal: controller.signal,
      onPublishError: () => undefined,
    });

    const unhandled = await withUnhandledRejectionCapture(async () => {
      await expect(publisher.publishAfterDurableWrite(pointerWrite())).resolves.toMatchObject([
        { published: false, receiverCount: 0 },
      ]);
    });
    expect(unhandled).toEqual([]);
    expect(publish).toHaveBeenCalledOnce();
    const dedicated = (redis.duplicate as ReturnType<typeof vi.fn>)
      .mock.results[0]!.value as WwRedis;
    expect(dedicated.destroy).toHaveBeenCalledOnce();
  });

  it('broadcast recipient snapshotlarini tek saglikli baglantida ayri pointerlar olarak yayinlar', async () => {
    const publish = vi.fn(async () => 0);
    const redis = redisWithPublish(publish as WwRedis['publish']);
    const expanded = broadcastWrite(3);

    const result = await new CommunicationWakeupPublisher(redis)
      .publishAfterDurableWrite(expanded);

    expect(result.map((item) => item.recipient)).toEqual(
      expanded.receipts.map((receipt) => receipt.recipient),
    );
    expect(publish).toHaveBeenCalledTimes(3);
    expect(redis.duplicate).toHaveBeenCalledOnce();
    const dedicated = (redis.duplicate as ReturnType<typeof vi.fn>)
      .mock.results[0]!.value as WwRedis;
    expect(dedicated.destroy).toHaveBeenCalledOnce();
  });

  it.each([
    ['receipt yok', (input: DurableCommunicationWrite) => ({ ...input, receipts: [] })],
    ['message ID farkli', (input: DurableCommunicationWrite) => ({
      ...input,
      receipts: [{ ...input.receipts[0]!, messageId: randomUUID() }],
    })],
    ['project ID farkli', (input: DurableCommunicationWrite) => ({
      ...input,
      receipts: [{ ...input.receipts[0]!, projectId: randomUUID() }],
    })],
    ['recipient ID snapshotla farkli', (input: DurableCommunicationWrite) => ({
      ...input,
      receipts: [{ ...input.receipts[0]!, recipientId: randomUUID() }],
    })],
    ['dogrudan recipient zarftan farkli', (input: DurableCommunicationWrite) => {
      const recipient = { type: 'agent' as const, id: randomUUID() };
      return {
        ...input,
        receipts: [{ ...input.receipts[0]!, recipientId: recipient.id, recipient }],
      };
    }],
    ['recipient tekrari', (input: DurableCommunicationWrite) => ({
      ...input,
      message: {
        ...input.message,
        recipient: { type: 'broadcast', id: BROADCAST_SENTINEL },
      },
      receipts: [input.receipts[0]!, input.receipts[0]!],
    })],
    ['receipt state enqueued degil', (input: DurableCommunicationWrite) => ({
      ...input,
      receipts: [{ ...input.receipts[0]!, state: 'processed' }],
    })],
    ['receipt recipient broadcast', (input: DurableCommunicationWrite) => ({
      ...input,
      message: {
        ...input.message,
        recipient: { type: 'broadcast', id: BROADCAST_SENTINEL },
      },
      receipts: [{
        ...input.receipts[0]!,
        recipientId: BROADCAST_SENTINEL,
        recipient: { type: 'broadcast', id: BROADCAST_SENTINEL },
      }],
    })],
  ] as const)('%s durumunu publish etmeden reddeder', async (_name, mutate) => {
    const publish = vi.fn(async () => 1);
    const input = mutate(pointerWrite()) as DurableCommunicationWrite;

    await expect(new CommunicationWakeupPublisher(
      redisWithPublish(publish as WwRedis['publish']),
    )
      .publishAfterDurableWrite(input)).rejects.toBeInstanceOf(Error);
    expect(publish).not.toHaveBeenCalled();
  });
});

describe.skipIf(!chUp)('durable inbox wakeup kaybi kurtarmasi', () => {
  const db = `ww_test_wakeup_${Date.now()}_${process.pid}`;
  let ch: ClickHouseClient;
  const projectId = randomUUID();
  const recipientId = randomUUID();

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

  async function persistInboxMessage(label: string): Promise<DurableCommunicationWrite> {
    const senderId = randomUUID();
    const envelope = {
      protocolVersion: 1,
      messageId: randomUUID(),
      projectId,
      sessionId: randomUUID(),
      senderPrincipalId: senderId,
      authenticatedPrincipal: {
        principalType: 'agent',
        principalId: senderId,
        role: 'worker',
        agentVersion: 1,
        authenticatedAt: '2026-08-14T10:00:00.000Z',
      },
      recipient: { type: 'agent', id: recipientId },
      kind: 'question',
      payload: { type: 'question', text: label },
      correlationId: randomUUID(),
      idempotencyKey: `wakeup-${label}-${randomUUID()}`,
      provenance: { class: 'system_generated' },
      priority: 'normal',
      createdAt: '2026-08-14T10:00:00.000Z',
    } satisfies AgentMessageEnvelopeV1;
    const message = await appendMessage(ch, { envelope });
    const receipt = await createReceipt(ch, {
      receipt_id: randomUUID(),
      message_id: envelope.messageId,
      project_id: projectId,
      recipient_id: recipientId,
      recipient_snapshot: envelope.recipient,
      state: 'enqueued',
      claim_owner: '',
      claim_fence: '0',
      retry_count: 0,
      error: '',
      created_at: envelope.createdAt,
    });
    return {
      message: {
        messageId: message.envelope.messageId,
        projectId: message.envelope.projectId,
        recipient: message.envelope.recipient,
      },
      receipts: [{
        messageId: receipt.message_id,
        projectId: receipt.project_id,
        recipientId: receipt.recipient_id,
        recipient: receipt.recipient_snapshot,
        state: 'enqueued',
      }],
    };
  }

  it('publish atlanir veya basarisiz olursa DB poll her iki mesaji da bulur', async () => {
    const skipped = await persistInboxMessage('publish-skipped');
    const failed = await persistInboxMessage('publish-failed');
    const publish = vi.fn(async () => { throw new Error('simulated Redis loss'); });
    await new CommunicationWakeupPublisher(
      redisWithPublish(publish as WwRedis['publish']),
      { onPublishError: () => undefined },
    ).publishAfterDurableWrite(failed);

    const polled = await listPendingInboxMessages(ch, projectId, recipientId);
    const ids = polled.map((record) => (
      record.protocolVersion === 1 ? record.envelope.messageId : record.messageId
    ));
    expect(new Set(ids)).toEqual(new Set([
      skipped.message.messageId,
      failed.message.messageId,
    ]));
    expect(publish).toHaveBeenCalledOnce();
  });
});
