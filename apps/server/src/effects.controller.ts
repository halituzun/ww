import { BadRequestException, Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { EFFECT_STATES, listLatestEffectsByState, type EffectState } from '@ww/db';
import { EntityIdSchema } from '@ww/shared';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';

/**
 * Dayanıklı efekt defteri görünümü.
 *
 * NEDEN VAR: non-replay-safe bir efekt 'uncertain' bittiğinde tasarım gereği
 * İNSAN MÜDAHALESİ gerekir (tekrar denemek yan etkiyi ikinci kez üretebilir).
 * Ama bu efektleri görmenin hiçbir yolu yoktu: sistem "birinin bakması lazım"
 * diyor, kimse göremiyordu. Kalıcı hata metni KASITLI olarak sansürlüdür
 * (sağlayıcı/anahtar/prompt sızmasın); burada da sansürlü kalır.
 */
@Controller('projects/:projectId/effects')
export class EffectsController {
  constructor(@Inject(SERVER_DATABASE) private readonly database: ServerDatabase) {}

  @Get()
  async list(
    @Param('projectId') projectId: string,
    @Query('state') state?: string,
  ) {
    const id = EntityIdSchema.parse(projectId);
    // Varsayılan 'uncertain': asıl dikkat isteyen durum budur.
    const requested = (state ?? 'uncertain') as EffectState;
    if (!(EFFECT_STATES as readonly string[]).includes(requested)) {
      throw new BadRequestException(
        `geçersiz efekt durumu: ${requested} (${EFFECT_STATES.join(', ')})`,
      );
    }
    const rows = await listLatestEffectsByState(this.database.ch, id, requested);
    return {
      state: requested,
      count: rows.length,
      effects: rows.map((row) => ({
        stableEffectId: row.stable_effect_id,
        effectType: row.effect_type,
        taskId: row.task_id,
        assignmentAttemptId: row.assignment_attempt_id,
        replaySafety: row.replay_safety,
        attempts: Number(row.effect_version),
        error: row.error,
        createdAt: row.created_at,
      })),
    };
  }
}
