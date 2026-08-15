import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { EntityIdSchema } from '@ww/shared';
import { listFileIndex } from '@ww/db';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';

@Controller('projects/:projectId/files')
export class FilesController {
  constructor(@Inject(SERVER_DATABASE) private readonly database: ServerDatabase) {}

  @Get()
  async list(@Param('projectId') projectId: string, @Query('limit') limit?: string) {
    const id = EntityIdSchema.parse(projectId);
    const parsedLimit = limit === undefined ? 1_000 : Number(limit);
    if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 5_000) {
      throw new Error('file index limiti gecersiz');
    }
    return listFileIndex(this.database.ch, id, parsedLimit);
  }
}
