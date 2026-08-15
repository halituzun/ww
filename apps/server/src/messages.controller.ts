import { Body, Controller, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { EntityIdSchema } from '@ww/shared';
import { parseLocalSession, type LocalSessionRequest } from './auth/local-session.js';
import { MESSAGE_APPLICATION, type MessageApplication } from './orchestration.module.js';

const MessageInput = z.strictObject({ kind: z.enum(['user_command', 'answer']), text: z.string().trim().min(1), taskId: EntityIdSchema.optional(), replyToMessageId: EntityIdSchema.optional() });
@Controller('projects/:projectId/messages')
export class MessagesController {
  constructor(@Inject(MESSAGE_APPLICATION) private readonly messages: MessageApplication) {}
  @Post()
  create(@Req() request: LocalSessionRequest, @Param('projectId') projectId: string, @Body() body: unknown) {
    const principal = parseLocalSession(request);
    const input = MessageInput.parse(body);
    return this.messages.send({ projectId, principal, kind: input.kind, text: input.text, ...(input.taskId === undefined ? {} : { taskId: input.taskId }), ...(input.replyToMessageId === undefined ? {} : { replyToMessageId: input.replyToMessageId }) });
  }
}
