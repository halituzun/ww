// docs/08 → plan onay akışı; docs/11 Faz 4 → "konsey planlar".
//
// Konsey bu uç olmadan hiçbir yerden tetiklenemiyordu.
import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { listLatestPlansByStatus, listMessagesBySession, listDecisions } from '@ww/db';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';
import { z } from 'zod';
import { parseLocalSession, type LocalSessionRequest } from './auth/local-session.js';
import { CouncilApplicationService, CouncilRunError } from './council.service.js';
import { CouncilMemberError } from './council-members.js';
import { goalFromPlanMarkdown } from './council-plan.js';
import type { EntityId } from '@ww/shared';

const CouncilInput = z.strictObject({ goal: z.string().trim().min(1).max(4_000) });

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

export function councilDiscussionText(payload: unknown): string {
  const record = objectRecord(payload);
  return firstString(
    record['markdown'],
    record['summary'],
    record['text'],
    record['instruction'],
    record['reason'],
  );
}

export function councilDiscussionSource(provenance: unknown, kind: unknown): {
  readonly sourceId: string;
  readonly sourceVersion: string;
  readonly councilKind: string;
} {
  const record = objectRecord(provenance);
  const sourceVersion = firstString(record['sourceVersion']);
  return {
    sourceId: firstString(record['sourceId']),
    sourceVersion,
    councilKind: sourceVersion || firstString(kind),
  };
}

@Controller('projects/:projectId/council')
export class CouncilController {
  constructor(
    @Inject(CouncilApplicationService) private readonly council: CouncilApplicationService,
    @Inject(SERVER_DATABASE) private readonly database: ServerDatabase,
  ) {}

  /** Projenin en güncel planındaki hedef; ek tur bunu taşır. */
  async #activeGoal(projectId: string): Promise<string> {
    const plans = (await Promise.all(
      (['approved', 'proposed', 'debating', 'superseded'] as const).map((status) =>
        listLatestPlansByStatus(this.database.ch, projectId as EntityId, status),
      ),
    )).flat();
    const latest = plans
      .sort((left, right) => right.observed_at.localeCompare(left.observed_at))[0];
    return latest === undefined ? '' : goalFromPlanMarkdown(latest.content_md);
  }

  /**
   * H3 — Projenin müzakere karar defteri kayıtları
   */
  @Get('decisions')
  async getDecisions(
    @Req() request: LocalSessionRequest,
    @Param('projectId') projectId: string,
  ) {
    parseLocalSession(request);
    return await listDecisions(this.database.ch, projectId);
  }

  /**
   * H4 — Kullanıcı kontrolü: ek müzakere turu talep etme
   */
  @Post('rounds')
  async requestAdditionalRound(
    @Req() request: LocalSessionRequest,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ) {
    parseLocalSession(request);
    const schema = z.strictObject({
      focusTopic: z.string().trim().min(1).max(2_000),
    });
    const { focusTopic } = schema.parse(body);
    try {
      // EK TUR, PROJENİN HEDEFİNİ TAŞIR. Eskiden yalnız odak cümlesiyle
      // koşuluyordu: konsey projenin ne olduğunu bilmeden yeniden müzakere
      // ediyor ve ortaya "ek tur" değil hedefsiz yeni bir plan çıkıyordu.
      const goal = await this.#activeGoal(projectId);
      if (goal === '') {
        throw new BadRequestException(
          'ek tur icin aktif plan bulunamadi: once konsey oturumu kosulmali',
        );
      }
      return await this.council.run(projectId, `${goal}\n\nEk müzakere odağı: ${focusTopic}`);
    } catch (reason) {
      if (reason instanceof CouncilRunError || reason instanceof CouncilMemberError) {
        throw new BadRequestException(reason.message);
      }
      throw reason;
    }
  }

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
    return rows.map((row) => {
      const envelope = 'envelope' in row
        ? (row.envelope as unknown as Record<string, unknown>)
        : (row as unknown as Record<string, unknown>);
      const source = councilDiscussionSource(envelope['provenance'], envelope['kind']);
      return {
        messageId: envelope['messageId'],
        kind: envelope['kind'],
        sourceId: source.sourceId,
        sourceVersion: source.sourceVersion,
        councilKind: source.councilKind,
        sender: envelope['sender'],
        createdAt: envelope['createdAt'],
        text: councilDiscussionText(envelope['payload']),
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
      if (reason instanceof CouncilRunError || reason instanceof CouncilMemberError) {
        throw new BadRequestException(reason.message);
      }
      throw reason;
    }
  }
}
