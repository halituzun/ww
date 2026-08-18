// docs/09 View → ViewModel → Service; docs/08 gereksinim sihirbazı.
import { useCallback, useEffect, useState } from 'react';
import {
  fetchInterviewQuestions,
  submitInterview,
  type InterviewQuestion,
} from '../services/interview.js';

export interface InterviewPorts {
  loadQuestions?: typeof fetchInterviewQuestions;
  submit?: typeof submitInterview;
}

export function useInterviewViewModel(projectId: string, ports: InterviewPorts = {}) {
  const load = ports.loadQuestions ?? fetchInterviewQuestions;
  const send = ports.submit ?? submitInterview;

  const [questions, setQuestions] = useState<InterviewQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!projectId) { setQuestions([]); setSaved(false); return; }
    let active = true;
    void load(projectId)
      .then((next) => { if (active) setQuestions(next.questions); })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Sorular alınamadı');
      });
    return () => { active = false; };
  }, [projectId, load]);

  const submit = useCallback(async (): Promise<void> => {
    if (!projectId) return;
    // Zorunlu soru boşken göndermek sunucuda reddedilir; kullanıcıya BURADA
    // söylemek, sebebi anlaşılmayan bir hatadan iyidir.
    const missing = questions
      .filter((question) => question.required && (answers[question.id] ?? '').trim() === '')
      .map((question) => question.prompt);
    if (missing.length > 0) {
      setError(`Zorunlu sorular cevaplanmadı: ${missing.join(' / ')}`);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await send(projectId, answers);
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Gereksinimler kaydedilemedi');
    } finally {
      setBusy(false);
    }
  }, [projectId, questions, answers, send]);

  return {
    questions,
    saved,
    error,
    busy,
    answerFor: (id: string) => answers[id] ?? '',
    setAnswer: (id: string, value: string) =>
      setAnswers((current) => ({ ...current, [id]: value })),
    submit,
  };
}
