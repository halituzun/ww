// Gereksinim sihirbazı (docs/11 Faz 4 → "sihirbazdan girilir").
//
// NEDEN VAR: `InterviewService` protokolü packages/agents içinde yazılmıştı
// ama `apps/` içinde tek referansı yoktu — yani sihirbaz hiçbir yerden
// çalıştırılamıyordu. Faz 4 kabul senaryosunun İLK adımı buydu.
//
// Cevaplar bellekte kalmaz: tamamlanan görüşme `knowledge`'a **requirement**
// olarak yazılır. Yazılmazsa gereksinimler oturum bitince kaybolur ve
// "asla unutmama" çekirdeği (docs/06) delinir.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { appendKnowledgeVersion, getLatestProject } from '@ww/db';
import { InterviewService as InterviewProtocol } from '@ww/agents';
import type { EntityId } from '@ww/shared';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';

export class InterviewError extends Error {}

export interface InterviewOutcome {
  readonly sessionId: EntityId;
  readonly complete: boolean;
  readonly knowledgeId: EntityId;
  readonly requirement: string;
  readonly answers: Readonly<Record<string, string>>;
}

/** Görüşme cevaplarından okunabilir bir gereksinim metni. */
export function buildRequirementDocument(
  projectName: string,
  questions: readonly { readonly id: string; readonly prompt: string }[],
  answers: Readonly<Record<string, string>>,
): string {
  return [
    `# ${projectName} — gereksinimler`,
    '',
    ...questions.flatMap((question) => {
      const answer = answers[question.id];
      return answer === undefined ? [] : [`## ${question.prompt}`, '', answer, ''];
    }),
  ].join('\n');
}

@Injectable()
export class InterviewApplicationService {
  readonly #database: ServerDatabase;
  readonly #protocol = new InterviewProtocol();

  constructor(@Inject(SERVER_DATABASE) database: ServerDatabase) {
    this.#database = database;
  }

  questions(projectId: string): readonly { id: string; prompt: string; required: boolean }[] {
    return this.#protocol.start(projectId as EntityId, randomUUID() as EntityId).questions;
  }

  /**
   * Cevaplar protokolün KENDİ kurallarından geçirilir (bilinmeyen soru, boş
   * cevap, zorunlu alan). Eksik cevapla gereksinim yazılmaz: yarım bir
   * gereksinim dokümanı, hiç olmayandan daha yanıltıcıdır.
   */
  async submit(
    projectId: string,
    answers: Readonly<Record<string, string>>,
  ): Promise<InterviewOutcome> {
    const project = await getLatestProject(this.#database.ch, projectId);
    if (project === null) throw new InterviewError('proje bulunamadi');

    const sessionId = randomUUID() as EntityId;
    let session = this.#protocol.start(project.project_id as EntityId, sessionId);
    for (const [questionId, answer] of Object.entries(answers)) {
      session = this.#protocol.answer(session, questionId, answer);
    }
    if (!session.complete) {
      throw new InterviewError('zorunlu sorular cevaplanmadan gereksinim yazilamaz');
    }

    const requirement = buildRequirementDocument(
      project.name, session.questions, session.answers,
    );
    const knowledgeId = randomUUID() as EntityId;
    await appendKnowledgeVersion(this.#database.ch, {
      knowledge_id: knowledgeId,
      project_id: project.project_id,
      kind: 'requirement',
      title: `${project.name} — gereksinimler`,
      content: requirement,
      tags: ['interview', 'faz4'],
      source_task_id: '00000000-0000-0000-0000-000000000000',
      source_message_id: '00000000-0000-0000-0000-000000000000',
      status: 'active',
      superseded_by: '00000000-0000-0000-0000-000000000000',
      created_at: new Date().toISOString(),
    } as never);

    return Object.freeze({
      sessionId,
      complete: true,
      knowledgeId,
      requirement,
      answers: session.answers,
    });
  }
}
