import { BadRequestException, Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { parseLocalSession, type LocalSessionRequest } from './auth/local-session.js';
import { InterviewApplicationService, InterviewError } from './interview.service.js';

const AnswersInput = z.strictObject({
  answers: z.record(z.string().trim().min(1), z.string()),
});

@Controller('projects/:projectId/interview')
export class InterviewController {
  constructor(private readonly interview: InterviewApplicationService) {}

  @Get()
  questions(@Req() request: LocalSessionRequest, @Param('projectId') projectId: string) {
    parseLocalSession(request);
    return { questions: this.interview.questions(projectId) };
  }

  @Post()
  async submit(
    @Req() request: LocalSessionRequest,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ) {
    parseLocalSession(request);
    const input = AnswersInput.parse(body);
    try {
      return await this.interview.submit(projectId, input.answers);
    } catch (reason) {
      // Eksik/geçersiz cevap kullanıcı hatasıdır; 500 vermek "sunucu bozuk"
      // yalanını söylerdi.
      throw new BadRequestException(reason instanceof InterviewError || reason instanceof Error
        ? reason.message : String(reason));
    }
  }
}
