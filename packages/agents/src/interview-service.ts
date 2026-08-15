import { canonicalSha256V1, type EntityId } from '@ww/shared';

export interface InterviewQuestion { readonly id: string; readonly prompt: string; readonly required: boolean; }
export interface InterviewSession { readonly sessionId: EntityId; readonly projectId: EntityId; readonly questions: readonly InterviewQuestion[]; readonly answers: Readonly<Record<string, string>>; readonly complete: boolean; readonly snapshotHash: string; }
export class InterviewService {
  start(projectId: EntityId, sessionId: EntityId): InterviewSession {
    const questions: readonly InterviewQuestion[] = Object.freeze([
      { id: 'goal', prompt: 'Bu projenin ana hedefi nedir?', required: true },
      { id: 'users', prompt: 'Kimler kullanacak?', required: true },
      { id: 'constraints', prompt: 'Teknik veya zaman kısıtları var mı?', required: false },
    ]);
    return this.snapshot({ sessionId, projectId, questions, answers: {}, complete: false });
  }
  answer(session: InterviewSession, questionId: string, answer: string): InterviewSession {
    if (!session.questions.some((question) => question.id === questionId)) throw new Error('interview sorusu bulunamadi');
    if (answer.trim().length === 0) throw new Error('interview cevabi bos olamaz');
    const answers = { ...session.answers, [questionId]: answer.trim() };
    const complete = session.questions.filter((question) => question.required).every((question) => typeof answers[question.id] === 'string');
    return this.snapshot({ ...session, answers, complete });
  }
  private snapshot(input: Omit<InterviewSession, 'snapshotHash'>): InterviewSession { return Object.freeze({ ...input, snapshotHash: canonicalSha256V1(input) }); }
}
