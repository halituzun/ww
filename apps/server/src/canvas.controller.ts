// docs/08 → Canlı Tuval: "ilk yük REST GET /projects/:id/canvas".
//
// Bu uç dokümanda ADIYLA tanımlıydı ama hiç yazılmamıştı; panel tuvali
// agent'ları değil görevleri çiziyordu.
import { Controller, Get, Inject, Param, Req } from '@nestjs/common';
import { listLatestAgents, listLatestTasks } from '@ww/db';
import type { EntityId } from '@ww/shared';
import { parseLocalSession, type LocalSessionRequest } from './auth/local-session.js';
import { buildCanvasProjection } from './canvas-projection.js';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';

@Controller('projects/:projectId/canvas')
export class CanvasController {
  constructor(@Inject(SERVER_DATABASE) private readonly database: ServerDatabase) {}

  @Get()
  async canvas(@Req() request: LocalSessionRequest, @Param('projectId') projectId: string) {
    parseLocalSession(request);
    const [agents, tasks] = await Promise.all([
      listLatestAgents(this.database.ch, projectId as EntityId),
      listLatestTasks(this.database.ch, projectId),
    ]);
    return buildCanvasProjection(agents as never, tasks as never);
  }
}
