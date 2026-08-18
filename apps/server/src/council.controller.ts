// docs/08 → plan onay akışı; docs/11 Faz 4 → "konsey planlar".
//
// Konsey bu uç olmadan hiçbir yerden tetiklenemiyordu.
import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { listMessagesBySession } from '@ww/db';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';
import { z } from 'zod';
import { parseLocalSession, type LocalSessionRequest } from './auth/local-session.js';
import { CouncilApplicationService, CouncilRunError } from './council.service.js';
import { CouncilMemberError } from './council-members.js';

const CouncilInput = z.strictObject({ goal: z.string().trim().min(1).max(4_000) });

@Controller('projects/:projectId/council')
export class CouncilController {
  constructor(
    @Inject(CouncilApplicationService) private readonly council: CouncilApplicationService,
    @Inject(SERVER_DATABASE) private readonly database: ServerDatabase,
  ) {}

  /**
   * Bir konsey oturumunun tartışması. "Bu karar nasıl alındı" zinciri:
   * plan → council_session_id → BU UÇ. Uç olmadan zincir okunamıyordu.
   */
  @Get(':sessionId')
  async discussion(
    @Req() request: LocalSessionRequest,
    @Param('projectId') projectId: string,
    @Param('sessionId') sessionId: string,
  ) {
    parseLocalSession(request);
    const rows = await listMessagesBySession(this.database.ch, projectId, sessionId);
    // MessageRecord İKİ varyantlı bir birleşimdir (protokol zarfı / eski
    // izdüşüm); yalnız birini varsaymak diğerinde boş alan döndürür.
    return rows.map((row) => {
      const envelope = 'envelope' in row
        ? (row.envelope as unknown as Record<string, unknown>)
        : (row as unknown as Record<string, unknown>);
      const payload = envelope['payload'] as { text?: string } | undefined;
      return {
        messageId: envelope['messageId'],
        kind: envelope['kind'],
        sender: envelope['sender'],
        createdAt: envelope['createdAt'],
        text: payload?.text ?? '',
      };
    });
  }

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
