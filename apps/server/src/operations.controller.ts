import { Controller, Get, Inject, Param } from '@nestjs/common';
import { EntityIdSchema } from '@ww/shared';
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
}
