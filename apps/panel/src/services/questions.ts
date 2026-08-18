// Bekleyen agent soruları ve cevapları (docs/08 → "bekleyen kullanıcı-onayı
// soruları kutusu"; docs/03 → tırmandırma zinciri worker → PM → kullanıcı).
//
// NEDEN VAR: panelde bu yüzey hiç yoktu. Sunucu uçları çalışıyordu ama
// kullanıcı bir agent sorusunu ne görebiliyor ne cevaplayabiliyordu —
// projenin ilk vizyon maddelerinden biri ("kullanıcı isterse görüp kendisi
// cevaplar") panelde karşılıksızdı.
import { getJson, requestJson, type RequestOptions } from './http.js';

export interface PendingQuestion {
  messageId: string;
  kind: string;
  taskId?: string;
  payload?: { text?: string };
  createdAt: string;
}

export interface PendingQuestions {
  recipientId: string;
  count: number;
  messages: PendingQuestion[];
}

export interface QuestionAnswer {
  messageId: string;
  senderPrincipalId: string;
  createdAt: string;
  text: string;
}

const scope = (projectId: string, path: string): string => `/projects/${projectId}${path}`;

export const fetchPendingQuestions = (
  projectId: string,
  options: RequestOptions = {},
): Promise<PendingQuestions> =>
  getJson<PendingQuestions>(scope(projectId, '/messages/pending'), options,
    'Bekleyen sorular alınamadı');

export const fetchAnswers = (
  projectId: string,
  messageId: string,
  options: RequestOptions = {},
): Promise<{ count: number; answers: QuestionAnswer[] }> =>
  getJson(scope(projectId, `/messages/${messageId}/answers`), options, 'Cevaplar alınamadı');

export const answerQuestion = (
  projectId: string,
  replyToMessageId: string,
  text: string,
  options: RequestOptions = {},
): Promise<unknown> =>
  requestJson(scope(projectId, '/messages'), {
    ...options, method: 'POST', body: { kind: 'answer', text, replyToMessageId },
  }, 'Cevap gönderilemedi');
