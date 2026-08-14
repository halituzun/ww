import { randomUUID } from 'node:crypto';
import { NIL_UUID } from '@ww/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCh, type ClickHouseClient } from '../client.js';
import { runMigrations } from '../migrate.js';
import { clickhouseUp } from '../testutil.js';
import { appendEvent, getEvent, listEvents, type EventRow } from './events.js';
import { RepositoryConflictError } from './types.js';

const up = await clickhouseUp();
describe.skipIf(!up)('events repository', () => {
  const db = `ww_test_events_${Date.now()}_${process.pid}`;
  let ch: ClickHouseClient;
  beforeAll(async () => { await runMigrations({ database: db }); ch = createCh({ database: db }); });
  afterAll(async () => {
    const admin = createCh({ database: 'default' });
    await admin.command({ query: `DROP DATABASE IF EXISTS ${db}` });
    await admin.close(); await ch.close();
  });
  const event = (): EventRow => ({
    event_id: randomUUID(), seq: '1', project_id: randomUUID(), task_id: NIL_UUID,
    agent_id: NIL_UUID, event_type: 'status_change', tool_name: '',
    payload: { from: 'queued', to: 'assigned' }, duration_ms: 0,
    created_at: new Date().toISOString(),
  });

  it('append/get yapar ve fiziksel retry kopyasini listede katlar', async () => {
    const row = await appendEvent(ch, event());
    await ch.insert({ table: 'events', values: [{ ...row, payload: JSON.stringify(row.payload) }], format: 'JSONEachRow' });
    expect(await getEvent(ch, row.event_id)).toEqual(row);
    expect(await listEvents(ch, row.project_id)).toEqual([row]);
  });

  it('ayni event kimligindeki divergent duplicate kaydi fail-closed reddeder', async () => {
    const row = await appendEvent(ch, event());
    await ch.insert({
      table: 'events', values: [{ ...row, payload: '{"different":true}' }], format: 'JSONEachRow',
    });
    await expect(listEvents(ch, row.project_id)).rejects.toBeInstanceOf(RepositoryConflictError);
  });

  it('fiziksel retry kopyalari mantiksal liste limitini tuketmez', async () => {
    const projectId = randomUUID();
    const first = {
      ...event(),
      project_id: projectId,
      seq: '1',
      created_at: '2090-01-01T00:00:00.000Z',
    };
    const second = {
      ...event(),
      project_id: projectId,
      seq: '2',
      created_at: '2090-01-01T00:00:01.000Z',
    };
    const storedFirst = await appendEvent(ch, first);
    const storedSecond = await appendEvent(ch, second);
    await ch.insert({
      table: 'events',
      values: [{ ...storedFirst, payload: JSON.stringify(storedFirst.payload) }],
      format: 'JSONEachRow',
    });

    expect((await listEvents(ch, projectId, { limit: 2 })).map((row) => row.event_id))
      .toEqual([storedFirst.event_id, storedSecond.event_id]);
  });
});
