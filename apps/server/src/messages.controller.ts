import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { EntityIdSchema } from '@ww/shared';
import { parseLocalSession, type LocalSessionRequest } from './auth/local-session.js';
import { listLatestAgents, listPendingInboxMessages, listRecentMessages } from '@ww/db';
import { CommandTaskError } from './command-task.js';
import { listProtocolV1AnswerRepliesToMessage } from '@ww/db';
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
  /**
   * Sohbet geçmişi (docs/08 → PM ile sohbet).
   *
   * Panel mesaj GÖNDEREBİLİYOR ama okuyamıyordu: sohbet salt-yazmaydı ve
   * kullanıcı hiçbir cevabı göremiyordu.
   */
  @Get()
  async list(
    @Param('projectId') projectId: string,
    @Query('limit') limit?: string,
  ) {
    const id = EntityIdSchema.parse(projectId);
    const parsed = limit === undefined ? 100 : Number(limit);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1_000) {
      throw new BadRequestException('mesaj limiti 1-1000 arasında olmalıdır');
    }
    const records = await listRecentMessages(this.#ch(), id, parsed);
    return records.map((record) => {
      if (record.protocolVersion === 1) {
        return {
          messageId: record.envelope.messageId,
          kind: record.envelope.kind,
          taskId: record.envelope.taskId,
          from: record.envelope.senderPrincipalId,
          to: record.envelope.recipient.id,
          payload: record.envelope.payload,
          createdAt: record.envelope.createdAt,
        };
      }
      return {
        messageId: record.messageId,
        kind: record.kind,
        taskId: record.taskId,
        from: record.fromId ?? 'agent',
        to: record.toId ?? 'user',
        payload: { text: record.content },
        createdAt: record.createdAt,
      };
    });
  }

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
    const answeredRes = await this.#ch().query({
      query: `SELECT DISTINCT reply_to_message_id FROM messages WHERE project_id = {projectId:UUID} AND kind = 'answer'`,
      query_params: { projectId: id },
      format: 'JSONEachRow',
    });
    const answeredRows = (await answeredRes.json()) as Array<{ reply_to_message_id: string }>;
    const answeredSet = new Set(answeredRows.map((r) => r.reply_to_message_id));
    const unAnsweredMessages = messages.filter((record) => {
      const msgId = record.protocolVersion === 1 ? record.envelope.messageId : record.messageId;
      return !answeredSet.has(msgId);
    });
    return {
      recipientId: recipient,
      count: unAnsweredMessages.length,
      // Kayıt iki şekilden biri olabilir (protokol v1 zarfı ya da eski
      // projeksiyon); ikisini de aynı okunur şekle indiriyoruz.
      messages: unAnsweredMessages.map((record) => {
        if (record.protocolVersion === 1) {
          return {
            messageId: record.envelope.messageId,
            kind: record.envelope.kind,
            taskId: record.envelope.taskId,
            payload: record.envelope.payload,
            createdAt: record.envelope.createdAt,
          };
        }
        return {
          messageId: record.messageId,
          kind: record.kind,
          taskId: record.taskId,
          payload: { text: record.content },
          createdAt: record.createdAt,
        };
      }),
    };
  }

  /**
   * Bir sorunun CEVAPLARI (docs/03 → soru-cevap zinciri).
   *
   * NEDEN VAR: panel bekleyen soruları gösteriyordu ama bir sorunun cevabını
   * okumanın hiçbir yolu yoktu — kullanıcı kendi yazdığı cevabı bile
   * göremiyor, soru "cevaplandı mı" belirsiz kalıyordu.
   */
  @Get(':messageId/answers')
  async answers(
    @Req() request: LocalSessionRequest,
    @Param('projectId') projectId: string,
    @Param('messageId') messageId: string,
  ) {
    parseLocalSession(request);
    const id = EntityIdSchema.parse(projectId);
    const records = await listProtocolV1AnswerRepliesToMessage(this.#ch(), id, messageId);
    return {
      replyToMessageId: messageId,
      count: records.length,
      answers: records.map((record) => ({
        messageId: record.envelope.messageId,
        senderPrincipalId: record.envelope.senderPrincipalId,
        createdAt: record.envelope.createdAt,
        text: (record.envelope.payload as { text?: string }).text ?? '',
      })),
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
      // Boş emir kullanıcı hatasıdır; 500 vermek "sunucu bozuk" yalanı olurdu.
      if (error instanceof MessageInputError || error instanceof CommandTaskError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    });
  }
}
