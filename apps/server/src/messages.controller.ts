import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { EntityIdSchema } from '@ww/shared';
import { parseLocalSession, type LocalSessionRequest } from './auth/local-session.js';
import { MESSAGE_APPLICATION, MessageInputError, type MessageApplication } from './orchestration.module.js';

const MessageInput = z.strictObject({ kind: z.enum(['user_command', 'answer']), text: z.string().trim().min(1), taskId: EntityIdSchema.optional(), replyToMessageId: EntityIdSchema.optional() }).superRefine((value, context) => {
  if (value.kind === 'answer' && value.replyToMessageId === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['replyToMessageId'], message: 'answer replyToMessageId gerektirir' });
  }
});
@Controller('projects/:projectId/messages')
export class MessagesController {
  constructor(@Inject(MESSAGE_APPLICATION) private readonly messages: MessageApplication) {}
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
