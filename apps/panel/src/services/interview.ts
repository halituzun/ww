// Gereksinim sihirbazı (docs/08 → "Yeni proje sihirbazı: ad + tür seçimi →
// interviewer agent'la gereksinim toplama").
//
// NEDEN VAR: sunucu uçları vardı ama panel projeyi DOĞRUDAN oluşturuyordu;
// gereksinim adımı hiç sorulmuyordu. Gereksinimsiz proje, konseyin ve
// worker'ların tahmin üzerine çalışması demektir.
import { getJson, requestJson, type RequestOptions } from './http.js';

export interface InterviewQuestion {
  id: string;
  prompt: string;
  required: boolean;
}

export interface InterviewResult {
  sessionId: string;
  complete: boolean;
  knowledgeId: string;
  requirement: string;
}

export const fetchInterviewQuestions = (
  projectId: string,
  options: RequestOptions = {},
): Promise<{ questions: InterviewQuestion[] }> =>
  getJson(`/projects/${projectId}/interview`, options, 'Sihirbaz soruları alınamadı');

export const submitInterview = (
  projectId: string,
  answers: Readonly<Record<string, string>>,
  options: RequestOptions = {},
): Promise<InterviewResult> =>
  requestJson<InterviewResult>(`/projects/${projectId}/interview`,
    { ...options, method: 'POST', body: { answers } }, 'Gereksinimler kaydedilemedi');
