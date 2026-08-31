// docs/08 → Denetim Ekranı; docs/11 Faz 4 → "denetçiler bulgu üretip düzelttirir".
//
// Denetim bu uç olmadan hiçbir yerden tetiklenemiyordu: bulguları yalnızca
// elle POST edebiliyordunuz, yani "denetçi" diye bir şey fiilen yoktu.
import { Inject, BadRequestException, Body, Controller, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { parseLocalSession, type LocalSessionRequest } from './auth/local-session.js';
import { StandardsAuditApplicationService } from './standards-audit.service.js';

const AuditRequest = z.strictObject({
  files: z.array(z.strictObject({
    filePath: z.string().trim().min(1),
    content: z.string(),
  })).min(1).max(200),
  taskId: z.string().uuid().optional(),
});

@Controller('projects/:projectId/standards-audit')
export class StandardsAuditController {
  constructor(@Inject(StandardsAuditApplicationService) private readonly audit: StandardsAuditApplicationService) {}

  @Post()
  async run(
    @Req() request: LocalSessionRequest,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ) {
    parseLocalSession(request);
    const input = AuditRequest.parse(body);
    try {
      return await this.audit.auditFiles(
        projectId,
        input.files,
        input.taskId as never,
      );
    } catch (reason) {
      throw new BadRequestException(reason instanceof Error ? reason.message : String(reason));
    }
  }
}
