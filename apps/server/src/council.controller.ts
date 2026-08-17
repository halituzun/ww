// docs/08 → plan onay akışı; docs/11 Faz 4 → "konsey planlar".
//
// Konsey bu uç olmadan hiçbir yerden tetiklenemiyordu.
import { BadRequestException, Body, Controller, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { parseLocalSession, type LocalSessionRequest } from './auth/local-session.js';
import { CouncilApplicationService, CouncilRunError } from './council.service.js';
import { CouncilMemberError } from './council-members.js';

const CouncilInput = z.strictObject({ goal: z.string().trim().min(1).max(4_000) });

@Controller('projects/:projectId/council')
export class CouncilController {
  constructor(private readonly council: CouncilApplicationService) {}

  @Post()
  async run(
    @Req() request: LocalSessionRequest,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ) {
    parseLocalSession(request);
    const { goal } = CouncilInput.parse(body);
    try {
      return await this.council.run(projectId, goal);
    } catch (reason) {
      // Konsey hatası 500 olarak dönerse kullanıcı "sunucu bozuk" sanır;
      // oysa sebep genelde yapılandırmadır (üye/model eksik).
      if (reason instanceof CouncilRunError || reason instanceof CouncilMemberError) {
        throw new BadRequestException(reason.message);
      }
      throw reason;
    }
  }
}
