import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { appendKnowledgeVersion, listLatestKnowledgeByStatus } from '@ww/db';
import { EntityIdSchema, type EntityId } from '@ww/shared';
import { parseLocalSession, type LocalSessionRequest } from './auth/local-session.js';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';
import { buildKnowledgeRow, parseKnowledgeInput } from './knowledge.service.js';

/**
 * Proje bilgisi (docs/06 → kararlar, kısıtlar, gereksinimler).
 *
 * Context Builder bu tabloyu okur; yazan olmadığı için bağlam paketinin
 * "proje kararları" bölümü daima boş kalıyordu.
 */
@Controller('projects/:projectId/knowledge')
export class KnowledgeController {
  constructor(@Inject(SERVER_DATABASE) private readonly database: ServerDatabase) {}

  @Get()
  async list(@Param('projectId') projectId: string, @Query('limit') limit?: string) {
    const id = EntityIdSchema.parse(projectId);
    const parsed = limit === undefined ? 200 : Number(limit);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1_000) {
      throw new BadRequestException('knowledge limiti 1-1000 arasında olmalıdır');
    }
    const rows = await listLatestKnowledgeByStatus(this.database.ch, id, 'active');
    // Limit istemcide değil BURADA uygulanır: sınırsız liste paneli boğar.
    return rows.slice(0, parsed);
  }

  @Post()
  async record(
    @Req() request: LocalSessionRequest,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ) {
    parseLocalSession(request);
    const id = EntityIdSchema.parse(projectId) as EntityId;
    const row = buildKnowledgeRow(id, parseKnowledgeInput(body), new Date().toISOString());
    try {
      return await appendKnowledgeVersion(this.database.ch, row as never);
    } catch (reason) {
      throw new BadRequestException(reason instanceof Error ? reason.message : String(reason));
    }
  }
}
