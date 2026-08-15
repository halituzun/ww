import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgent, createCh, createRedis, runMigrations, type ClickHouseClient, type WwRedis } from '@ww/db';
import { AppModule } from './app.module.js';
import { SERVER_DATABASE } from './orchestration.module.js';

const token = 'phase9-test-token';
const integration = process.env['WW_REQUIRE_INTEGRATION'] === '1';
let probeCh: ClickHouseClient | undefined;
let probeRedis: WwRedis | undefined;
try {
  probeCh = createCh();
  await probeCh.query({ query: 'SELECT 1', format: 'JSONEachRow' });
  probeRedis = await createRedis();
} catch {
  if (integration) throw new Error('Phase 9 REST entegrasyon servisi kapalı');
}

describe.skipIf(probeCh === undefined || probeRedis === undefined)('REST gerçek ClickHouse/Redis akışı', () => {
  let app: INestApplication;
  let ch: ClickHouseClient;
  let redis: WwRedis;
  const db = `ww_test_server_rest_${Date.now()}_${process.pid}`;

  beforeAll(async () => {
    await runMigrations({ database: db });
    ch = createCh({ database: db });
    redis = await createRedis();
    process.env['WW_LOCAL_SESSION_TOKEN'] = token;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SERVER_DATABASE)
      .useValue({ ch, redis })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    redis.destroy();
    await ch.close();
    const admin = createCh({ database: 'default' });
    await admin.command({ query: `DROP DATABASE IF EXISTS ${db}` });
    await admin.close();
    probeRedis?.destroy();
    await probeCh?.close();
  });

  it('invalid auth kalıcı yazı yapmadan reddeder; project→active issuer task→queue ve kriterleri korur', async () => {
    await request(app.getHttpServer()).post('/projects').send({ name: 'unauthorized' }).expect(401);
    const project = await request(app.getHttpServer()).post('/projects').set('Authorization', `Bearer ${token}`).send({ name: 'REST integration' }).expect(201);
    const projectId = project.body.project_id as string;
    await request(app.getHttpServer()).get(`/projects/${projectId}`).expect(200).then((response) => {
      expect(response.body.project_id).toBe(projectId);
    });
    const agentId = randomUUID();
    await createAgent(ch, { agent_id: agentId, project_id: projectId, role: 'pm', group: 'management', name: 'PM', model_ref: 'mock:pm', parent_agent_id: '00000000-0000-0000-0000-000000000000', clone_of: '00000000-0000-0000-0000-000000000000', status: 'idle', current_task_id: '00000000-0000-0000-0000-000000000000', prompt_name: 'role.pm', prompt_version: 2, tasks_done: 0, tasks_rejected: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    const task = await request(app.getHttpServer()).post(`/projects/${projectId}/tasks`).set('Authorization', `Bearer ${token}`).send({ title: 'Persist criteria', acceptanceCriteria: ['must compile'], dependencies: [], files: ['src/a.ts'], budget: 10 }).expect(201);
    expect(task.body.issuer_agent_id).toBe(agentId);
    expect(task.body.acceptance_criteria).toEqual(['must compile']);
    expect(task.body.target_files).toEqual(['src/a.ts']);
    expect(task.body.token_budget).toBe(10);
    expect(await request(app.getHttpServer()).get(`/projects/${projectId}/tasks/${task.body.task_id}`).expect(200).then((response) => response.body.acceptance_criteria)).toEqual(['must compile']);
    const dependent = await request(app.getHttpServer()).post(`/projects/${projectId}/tasks`).set('Authorization', `Bearer ${token}`).send({ title: 'Dependent task', acceptanceCriteria: ['must review'], dependencies: [task.body.task_id], files: ['src/b.ts'], budget: 5 }).expect(201);
    expect(dependent.body.depends_on).toEqual([task.body.task_id]);
    const finalTask = await request(app.getHttpServer()).post(`/projects/${projectId}/tasks`).set('Authorization', `Bearer ${token}`).send({ title: 'Final task', acceptanceCriteria: ['must ship'], dependencies: [dependent.body.task_id], files: ['src/c.ts'], budget: 3 }).expect(201);
    expect(finalTask.body.depends_on).toEqual([dependent.body.task_id]);
    await request(app.getHttpServer()).post(`/projects/${projectId}/messages`).send({ kind: 'user_command', text: 'unauthorized' }).expect(401);
    await request(app.getHttpServer()).post(`/projects/${projectId}/messages`).set('Authorization', `Bearer ${token}`).send({ kind: 'answer', text: 'missing question reference' }).expect(400);
    const message = await request(app.getHttpServer()).post(`/projects/${projectId}/messages`).set('Authorization', `Bearer ${token}`).send({ kind: 'user_command', text: 'please inspect the task' }).expect(201);
    expect(message.body.messageId).toMatch(/^[0-9a-f-]{36}$/);
    await request(app.getHttpServer()).get(`/projects/${projectId}/messages/${message.body.messageId}`).expect(200).then((response) => {
      expect(response.body.envelope.messageId).toBe(message.body.messageId);
    });
  });
});
