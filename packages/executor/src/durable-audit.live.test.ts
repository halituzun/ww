import { randomUUID } from 'node:crypto';
import {
  createCh,
  runMigrations,
  type AppendEventInput,
  type ClickHouseClient,
  type EventRow,
} from '@ww/db';
import { EntityIdSchema } from '@ww/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DurableExecutorIntent,
  clickHouseExecutorEventStore,
  type ExecutorEventStorePort,
} from './durable-audit.js';
import type { ExecutorToolIntent } from './ports.js';

const live = process.env['WW_DOCKER_LIVE'] === '1';
const id = () => EntityIdSchema.parse(randomUUID());
const database = `ww_test_executor_intent_${Date.now()}_${process.pid}`;
let ch: ClickHouseClient;

function intent(): ExecutorToolIntent {
  return Object.freeze({
    callId: id(),
    toolName: 'edit_file',
    projectId: id(),
    taskId: id(),
    taskBriefId: id(),
    assignmentAttemptId: id(),
    agentId: id(),
    leaseOwner: 'scheduler:live',
    leaseFence: 11,
    argsHash: 'a'.repeat(64),
    requestHash: 'b'.repeat(64),
    occurredAt: '2026-08-15T10:00:00.000Z',
  });
}

describe.skipIf(!live)('DurableExecutorIntent live ClickHouse race', () => {
  beforeAll(async () => {
    await runMigrations({ database });
    ch = createCh({ database });
  });

  afterAll(async () => {
    await ch.close();
    const admin = createCh({ database: 'default' });
    await admin.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await admin.close();
  });

  it('concurrent exact insert ve accepted-response-loss altında iki accepted üretmez', async () => {
    const base = clickHouseExecutorEventStore(ch);
    let loseResponse = true;
    const responseLossStore: ExecutorEventStorePort = {
      get: async (eventId) => await base.get(eventId),
      append: async (event: AppendEventInput): Promise<EventRow> => {
        const stored = await base.append(event);
        if (loseResponse) {
          loseResponse = false;
          throw new Error('accepted response lost');
        }
        return stored;
      },
    };
    const value = intent();
    const ledgers = [
      new DurableExecutorIntent(responseLossStore),
      ...Array.from({ length: 15 }, () => new DurableExecutorIntent(base)),
    ];
    const results = await Promise.all(ledgers.map(async (ledger) => await ledger.accept(value)));
    expect(results.filter((result) => result.state === 'accepted')).toHaveLength(0);
    expect(results.every((result) => result.state === 'replay' || result.state === 'uncertain')).toBe(true);
    await expect(new DurableExecutorIntent(base).accept(value)).resolves.toEqual({ state: 'replay' });
  });
});
