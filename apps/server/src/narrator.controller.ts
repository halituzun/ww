import { Body, Controller, Inject, Post, Param } from '@nestjs/common';
import { narrateEvent } from './narrator-evidence.js';
import { z } from 'zod';
import { EntityIdSchema, type EntityId } from '@ww/shared';
import { listEvents } from '@ww/db';
import { NarratorService } from '@ww/memory';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';

const NarratorInput = z.strictObject({ question: z.string().trim().min(1).max(2_000), cutoffAt: z.string().datetime().optional() });

@Controller('projects/:projectId/narrator')
export class NarratorController {
  readonly #narrator = new NarratorService();
  constructor(@Inject(SERVER_DATABASE) private readonly database: ServerDatabase) {}

  @Post()
  async answer(@Param('projectId') projectId: string, @Body() body: unknown) {
    const id = EntityIdSchema.parse(projectId) as EntityId;
    const input = NarratorInput.parse(body);
    const events = await listEvents(this.database.ch, id, { limit: 200 });
    return this.#narrator.answer({
      projectId: id,
      question: input.question,
      ...(input.cutoffAt === undefined ? {} : { cutoffAt: input.cutoffAt }),
      // Ham JSON yükü okunamaz bir döküm üretiyordu; olaylar insan
      // cümlesine çevrilir (kaynak kimliği kanıt olarak korunur).
      evidence: events.map((event) => ({
        source: `event:${event.event_id}`,
        summary: narrateEvent(event as never),
        createdAt: event.created_at,
      })),
    });
  }
}
