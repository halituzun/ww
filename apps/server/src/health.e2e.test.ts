import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { HealthReport } from '@ww/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from './app.module.js';
import {
  DEFAULT_HEALTH_DEPENDENCIES,
  HealthService,
} from './health.service.js';
import { integrationRequired } from './integration.js';

const requireIntegration = integrationRequired();
const initialReport = await new HealthService(DEFAULT_HEALTH_DEPENDENCIES).check();

describe('GET /health', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('servisler kapalı olsa da yanıt şeklini ve ok invariantını korur', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);
    const report = response.body as HealthReport;

    expect(Object.keys(report).sort()).toEqual(['clickhouse', 'ok', 'redis']);
    expect(typeof report.ok).toBe('boolean');
    expect(typeof report.clickhouse).toBe('boolean');
    expect(typeof report.redis).toBe('boolean');
    expect(report.ok).toBe(report.clickhouse && report.redis);
  });

  describe.skipIf(!requireIntegration && !initialReport.ok)('servisler ayaktayken', () => {
    it('sağlıklı durum döndürür', async () => {
      if (!initialReport.ok) {
        throw new Error(
          `WW_REQUIRE_INTEGRATION açık ancak probe başarısız: ${JSON.stringify(initialReport)}`,
        );
      }
      await request(app.getHttpServer())
        .get('/health')
        .expect(200)
        .expect({ ok: true, clickhouse: true, redis: true });
    });
  });
});
