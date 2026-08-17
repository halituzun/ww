import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { EntityIdSchema } from '@ww/shared';
import { parseLocalSession, type LocalSessionRequest } from './auth/local-session.js';
import { listLatestAgents, listPendingInboxMessages } from '@ww/db';
import { MESSAGE_APPLICATION, MessageInputError, SERVER_DATABASE, type MessageApplication, type ServerDatabase } from './orchestration.module.js';

const MessageInput = z.strictObject({ kind: z.enum(['user_command', 'answer']), text: z.string().trim().min(1), taskId: EntityIdSchema.optional(), replyToMessageId: EntityIdSchema.optional() }).superRefine((value, context) => {
  if (value.kind === 'answer' && value.replyToMessageId === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['replyToMessageId'], message: 'answer replyToMessageId gerektirir' });
  }
});
@Controller('projects/:projectId/messages')
export class MessagesController {
  constructor(
    @Inject(MESSAGE_APPLICATION) private readonly messages: MessageApplication,
    @Inject(SERVER_DATABASE) private readonly database: ServerDatabase,
  ) {}

  #ch() { return this.database.ch; }
  /**
   * Bekleyen sorular kutusu (docs/08).
   *
   * NEDEN VAR: worker soru sorabiliyor ve görev 'waiting_user'a düşüyordu ama
   * soruyu LİSTELEYEN hiçbir uç yoktu: soru kullanıcı için görünmez kalıyor,
   * görev sonsuza dek cevap bekliyordu. Soru sorma akışı kullanıcı açısından
   * kör bir sokakta bitiyordu.
   */
  @Get('pending')
  async pending(
    @Param('projectId') projectId: string,
    @Query('recipientId') recipientId?: string,
  ) {
    const id = EntityIdSchema.parse(projectId);
    // Varsayılan alıcı projenin PM'idir: sorular oraya düşer (docs/03
    // tırmandırma zinciri: worker → PM → kullanıcı).
    const recipient = recipientId ?? (await listLatestAgents(this.#ch(), id))
      .find((agent) => agent.role === 'pm' && agent.status !== 'stopped')?.agent_id;
    if (recipient === undefined) {
      throw new BadRequestException('alıcı bulunamadı: projede aktif PM yok');
    }
    const messages = await listPendingInboxMessages(this.#ch(), id, recipient);
    return {
      recipientId: recipient,
      count: messages.length,
      // Kayıt iki şekilden biri olabilir (protokol v1 zarfı ya da eski
      // projeksiyon); ikisini de aynı okunur şekle indiriyoruz.
      messages: messages.map((record) => {
        const envelope = 'envelope' in record
          ? (record.envelope as unknown as Record<string, unknown>)
          : (record as unknown as Record<string, unknown>);
        return {
          messageId: envelope['messageId'],
          kind: envelope['kind'],
          taskId: envelope['taskId'],
          payload: envelope['payload'],
          createdAt: envelope['createdAt'],
        };
      }),
    };
  }

  @Get(':messageId')
  get(@Param('projectId') projectId: string, @Param('messageId') messageId: string) {
    return this.messages.get(projectId, messageId);
  }
  @Post()
  create(@Req() request: LocalSessionRequest, @Param('projectId') projectId: string, @Body() body: unknown) {
    const principal = parseLocalSession(request);
    const parsed = MessageInput.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const input = parsed.data;
    return this.messages.send({ projectId, principal, kind: input.kind, text: input.text, ...(input.taskId === undefined ? {} : { taskId: input.taskId }), ...(input.replyToMessageId === undefined ? {} : { replyToMessageId: input.replyToMessageId }) }).catch((error: unknown) => {
      if (error instanceof MessageInputError) throw new BadRequestException(error.message);
      throw error;
    });
  }
}
