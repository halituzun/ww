// docs/09 View → ViewModel → Service; docs/08 gereksinim sihirbazı.
import { useCallback, useEffect, useState } from 'react';
import {
  fetchInterviewQuestions,
  submitInterview,
  type InterviewQuestion,
} from '../services/interview.js';
import { runCouncil } from '../services/council.js';

/**
 * Sihirbazdan sonra konseyin durumu.
 *
 * NEDEN görünür bir durum: konsey turları gerçek model çağrısıdır ve
 * dakikalar sürer. Sessizce beklemek, kullanıcıya "hiçbir şey olmadı" gibi
 * görünür — bu deponun tekrar eden kusur sınıfı.
 */
export type CouncilState = 'idle' | 'running' | 'done' | 'error';

export interface InterviewPorts {
  loadQuestions?: typeof fetchInterviewQuestions;
  submit?: typeof submitInterview;
  startCouncil?: typeof runCouncil;
}

export function useInterviewViewModel(projectId: string, ports: InterviewPorts = {}) {
  const load = ports.loadQuestions ?? fetchInterviewQuestions;
  const send = ports.submit ?? submitInterview;
  const council = ports.startCouncil ?? runCouncil;

  const [questions, setQuestions] = useState<InterviewQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [councilState, setCouncilState] = useState<CouncilState>('idle');
  const [councilError, setCouncilError] = useState('');

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
    let requirement = '';
    try {
      const outcome = await send(projectId, answers);
      requirement = outcome.requirement;
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Gereksinimler kaydedilemedi');
      return;
    } finally {
      setBusy(false);
    }

    // ZİNCİRİN BAĞLANDIĞI YER: gereksinim yazıldıktan sonra konsey KENDİLİĞİNDEN
    // koşar. Önceden burada hiçbir şey yoktu; gereksinim knowledge'a yazılıp
    // kalıyor, plan ancak elle `curl` ile üretilebiliyordu.
    //
    // Konsey hatası gereksinimin kaydedildiği gerçeğini geçersiz kılmaz; bu
    // yüzden ayrı bir durumda raporlanır.
    setCouncilState('running');
    setCouncilError('');
    try {
      await council(projectId, requirement);
      setCouncilState('done');
    } catch (reason) {
      setCouncilState('error');
      setCouncilError(reason instanceof Error ? reason.message : 'Konsey oturumu başlatılamadı');
    }
  }, [projectId, questions, answers, send, council]);

  return {
    questions,
    saved,
    error,
    busy,
    councilState,
    councilError,
    answerFor: (id: string) => answers[id] ?? '',
    setAnswer: (id: string, value: string) =>
      setAnswers((current) => ({ ...current, [id]: value })),
    submit,
  };
}
