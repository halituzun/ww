import { Body, Controller, Inject, Post, Param } from '@nestjs/common';
import { narrateEvent } from './narrator-evidence.js';
import { z } from 'zod';
import { EntityIdSchema, type EntityId } from '@ww/shared';
import { listRecentEvents } from '@ww/db';
import { NarratorService } from '@ww/memory';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';
import { focusEvidence } from './narrator-focus.js';

const NarratorInput = z.strictObject({ question: z.string().trim().min(1).max(2_000), cutoffAt: z.string().datetime().optional() });

@Controller('projects/:projectId/narrator')
export class NarratorController {
  readonly #narrator = new NarratorService();
  constructor(@Inject(SERVER_DATABASE) private readonly database: ServerDatabase) {}

  @Post()
  async answer(@Param('projectId') projectId: string, @Body() body: unknown) {
    const id = EntityIdSchema.parse(projectId) as EntityId;
    const input = NarratorInput.parse(body);
    // EN YENİ olaylar okunur. `listEvents` imleçsiz çağrıldığında en ESKİ
    // 200 olayı döndürüyordu: 4393 olaylı bir projede anlatıcı hep projenin
    // en eski geçmişini anlatıyor, sorulan işe hiç değinmiyordu.
    const events = await listRecentEvents(this.database.ch, id, 200);
    return this.#narrator.answer({
      projectId: id,
      question: input.question,
      ...(input.cutoffAt === undefined ? {} : { cutoffAt: input.cutoffAt }),
      // Ham JSON yükü okunamaz bir döküm üretiyordu; olaylar insan
      // cümlesine çevrilir (kaynak kimliği kanıt olarak korunur).
      // Kanıt SORUYA odaklanır: eskiden sorulan şey yok sayılıp son 200 olay
      // düz bir duvar hâlinde birleştiriliyordu (bkz. narrator-focus.ts).
      evidence: focusEvidence(events.map((event) => ({
        source: `event:${event.event_id}`,
        summary: narrateEvent(event as never),
        createdAt: event.created_at,
        taskId: event.task_id,
        // Yük JSON değeri olabilir; konu araması metin üzerinde yapılır.
        raw: typeof event.payload === 'string' ? event.payload : JSON.stringify(event.payload),
      })), input.question).map((entry) => ({
        source: entry.source,
        summary: entry.summary,
        createdAt: entry.createdAt,
      })),
    });
  }
}
