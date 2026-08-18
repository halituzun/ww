// docs/08 → Canlı Tuval: "ilk yük REST GET /projects/:id/canvas".
//
// Bu uç dokümanda ADIYLA tanımlıydı ama hiç yazılmamıştı; panel tuvali
// agent'ları değil görevleri çiziyordu.
import { Controller, Get, Inject, Param, Req } from '@nestjs/common';
import { checkHeartbeat, listLatestAgents, listLatestTasks } from '@ww/db';
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

    // Kaydedilmiş durum tek başına yalan söyleyebilir: süreç ölünce satır
    // 'busy' kalır. Canlılık işareti Redis'ten okunur; Redis yoksa kimse
    // "yanıt vermiyor" işaretlenmez (bilgi yoksa suçlamayız).
    const redis = this.database.redis;
    let live: Set<string> | undefined;
    if (redis !== undefined) {
      live = new Set<string>();
      for (const agent of agents) {
        if (await checkHeartbeat(redis, agent.agent_id)) live.add(agent.agent_id);
      }
    }

    return buildCanvasProjection(agents as never, tasks as never, live);
  }
}
