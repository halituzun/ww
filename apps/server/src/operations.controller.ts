import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { ARTIFACT_TYPES, EntityIdSchema } from '@ww/shared';
import { listProjectArtifacts } from '@ww/db';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';

@Controller('projects/:projectId')
export class OperationsController {
  constructor(@Inject(SERVER_DATABASE) private readonly database: ServerDatabase) {}

  @Get('usage')
  async usage(@Param('projectId') projectId: string): Promise<unknown> {
    const id = EntityIdSchema.parse(projectId);
    const result = await this.database.ch.query({
      query: `SELECT sum(cost_usd) AS cost_usd, sum(prompt_tokens) AS prompt_tokens,
        sum(completion_tokens) AS completion_tokens, count() AS calls
        FROM api_usage WHERE project_id = {projectId:UUID}`,
      query_params: { projectId: id }, format: 'JSONEachRow',
    });
    const rows = await result.json<Record<string, string | number>>();
    const row = rows[0] ?? {};
    return { projectId: id, costUsd: Number(row['cost_usd'] ?? 0), promptTokens: Number(row['prompt_tokens'] ?? 0), completionTokens: Number(row['completion_tokens'] ?? 0), calls: Number(row['calls'] ?? 0) };
  }

  @Get('provider-health')
  async providerHealth(@Param('projectId') projectId: string): Promise<unknown> {
    EntityIdSchema.parse(projectId);
    const result = await this.database.ch.query({
      query: `SELECT provider_id, argMax(health_status, version) AS health_status,
        argMax(last_health_check, version) AS last_health_check
        FROM api_providers
        GROUP BY provider_id ORDER BY provider_id`,
      query_params: {}, format: 'JSONEachRow',
    });
    return await result.json();
  }

  @Get('artifacts')
  async artifacts(@Param('projectId') projectId: string, @Query('type') type?: string) {
    const id = EntityIdSchema.parse(projectId);
    const artifactType = type === undefined ? undefined : ARTIFACT_TYPES.find((item) => item === type);
    if (type !== undefined && artifactType === undefined) throw new Error('artifact tipi gecersiz');
    return listProjectArtifacts(this.database.ch, id, artifactType === undefined ? {} : { artifactType });
  }
}
