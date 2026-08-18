import { withScreenContext } from './command-context.js';
import { loadSignal } from './workspace-signals.js';
import type { PanelTab } from '../services/tabs.js';
// Çalışma alanı ekranının ViewModel'i (docs/09 MVVM).
//
// NEDEN VAR: App.tsx bir View olmasına rağmen 20+ useState, 4 useEffect,
// yoklama döngüleri, WebSocket yaşam döngüsü ve 5 eylemi kendi içinde
// taşıyordu. docs/09 kontrol listesi bunu açıkça yasaklar: "View'da
// fetch/iş mantığı yasak". Durum ve eylemler burada; View yalnızca çizer.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  appendTimelineEvent, countTaskStatuses, pickSelectedFile, type TimelineEvent,
} from './workspace-logic.js';
import { createLiveEventSubscription } from './live-subscription.js';
import { replayAt } from './timeline-replay.js';
import type { ConnectionState } from './live-connection.js';
import { fetchBudgetReport, EMPTY_BUDGET_REPORT, type BudgetReport } from '../services/budget.js';
import { fetchAuditReport, EMPTY_AUDIT_REPORT, type AuditReport } from '../services/audit.js';
import { fetchProviders, type Provider } from '../services/providers.js';
import {
  askNarrator as askNarratorService,
  createProject as createProjectService,
  fetchApiArtifacts, fetchFiles, fetchProject, fetchProjects, fetchProviderHealth,
  fetchTasks, fetchUsage, sendUserCommand,
  updateProjectStatus as updateProjectStatusService,
  type ApiArtifact, type FileIndex, type Project, type ProviderHealth, type Task, type Usage,
} from '../services/projects.js';

const apiBase = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

const WORKSPACE_POLL_MS = 2_000;
const SIGNAL_POLL_MS = 15_000;

const errorText = (reason: unknown, fallback: string): string =>
  reason instanceof Error ? reason.message : fallback;

const queryParam = (name: string): string | null =>
  typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get(name);

export function useWorkspaceViewModel() {
  const [page, setPage] = useState<'workspace' | 'providers'>(
    () => queryParam('page') === 'providers' ? 'providers' : 'workspace',
  );
  const [projectId, setProjectId] = useState(() => queryParam('project') ?? '');
  const [budgetReport, setBudgetReport] = useState<BudgetReport>(EMPTY_BUDGET_REPORT);
  const [auditReport, setAuditReport] = useState<AuditReport>(EMPTY_AUDIT_REPORT);
  const [providerList, setProviderList] = useState<Provider[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectDraft, setProjectDraft] = useState({ name: '', type: 'web', budget: '10' });
  const [projectStatusMessage, setProjectStatusMessage] = useState('');
  const [projectStatus, setProjectStatus] = useState<string>('');
  const [usage, setUsage] = useState<Usage | null>(null);
  const [files, setFiles] = useState<FileIndex[]>([]);
  const [providerHealth, setProviderHealth] = useState<ProviderHealth[]>([]);
  const [apiArtifacts, setApiArtifacts] = useState<ApiArtifact[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | undefined>();
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [connection, setConnection] = useState<ConnectionState>('offline');
  const eventsRef = useRef<TimelineEvent[]>([]);
  const [message, setMessage] = useState('');
  const [messageStatus, setMessageStatus] = useState('');
  const [narratorQuestion, setNarratorQuestion] = useState('Bunu nasıl yaptın?');
  const [narratorResult, setNarratorResult] = useState<
    { answer: string; evidenceRefs: string[] } | null
  >(null);
  // docs/11 Faz 5: geçmişe kaydırıcı. Sonsuz (Infinity) "canlı" demektir;
  // yeni olay geldikçe kullanıcı geçmişten canlıya sürüklenmez.
  const [timelineCursor, setTimelineCursor] = useState(Number.POSITIVE_INFINITY);
  // docs/08: tuvalde seçilen agent'ın geçmişi yan panelde açılır.
  const [selectedAgent, setSelectedAgent] = useState<string | undefined>();
  const [tab, setTab] = useState<PanelTab>('tasks');
  // "Proje yok" ile "liste alınamadı" ayrı tutulur: ikisini karıştırmak
  // kullanıcıya projelerini kaybettiğini düşündürür.
  const [projectsError, setProjectsError] = useState('');
  // Çalışma alanı verisi ALINAMADI. Boş listelerden ayrı tutulur: "görev yok"
  // ile "görev listesi gelmedi" aynı şey değildir.
  const [workspaceError, setWorkspaceError] = useState('');

  useEffect(() => {
    if (projectId) return;
    // Hata YAKALANIR: bu uç artık hatayı yutmuyor. Yakalamazsak yakalanmamış
    // promise reddi oluşur (geçen turda tam bunu yaşadım).
    void loadSignal(
      fetchProjects, setProjects, () => true,
      (reason) => setProjectsError(
        reason instanceof Error ? reason.message : 'Proje listesi alınamadı',
      ),
    );
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    const load = async () => {
      // Uçlardan biri artık hatayı yutmuyor; Promise.all içinde reddedince
      // TÜM yükleme düşer. Yakalamazsak hiçbir yüzey güncellenmez ve panel
      // sessizce donar — düzelttiğimiz yalanın yerine daha kötüsü geçerdi.
      let loaded;
      try {
        loaded = await Promise.all([
          fetchProject(projectId), fetchTasks(projectId), fetchUsage(projectId),
          fetchFiles(projectId), fetchProviderHealth(projectId), fetchApiArtifacts(projectId),
        ]);
      } catch (reason) {
        if (active) {
          setWorkspaceError(
            reason instanceof Error ? reason.message : 'Çalışma alanı verisi alınamadı',
          );
        }
        return;
      }
      const [project, nextTasks, nextUsage, nextFiles, health, artifacts] = loaded;
      if (!active) return;
      setWorkspaceError('');
      if (project) setProjectStatus(project.status);
      setTasks(nextTasks);
      setUsage(nextUsage);
      setFiles(nextFiles);
      setSelectedFile((current) => pickSelectedFile(current, nextFiles));
      setProviderHealth(health);
      setApiArtifacts(artifacts);
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, WORKSPACE_POLL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [projectId]);

  // Kopan bağlantı sessizce ölmemeli; yaşam döngüsü live-subscription'da test edilir.
  useEffect(() => {
    if (!projectId || typeof WebSocket === 'undefined') return;
    return createLiveEventSubscription({
      url: `${apiBase.replace(/^http/, 'ws')}/events`,
      projectId,
      initialEvents: eventsRef.current,
      createSocket: (url) => new WebSocket(url) as unknown as never,
      setTimer: (fn, delay) => window.setTimeout(fn, delay),
      clearTimer: (handle) => window.clearTimeout(handle),
      onState: setConnection,
      onEvent: (next) => {
        setEvents((current) => {
          const updated = appendTimelineEvent(current, next);
          eventsRef.current = updated;
          return updated;
        });
      },
    });
  }, [projectId]);

  // docs/08 bildirim kaynakları: bütçe, sağlayıcı sağlığı, bekleyen soru, tırmandırma.
  useEffect(() => {
    let active = true;
    const load = () => {
      // Hatalar YAKALANIR: bu uçların bir kısmı artık hatayı yutmuyor
      // (bilinçli), ama burada yakalanmazsa panelde yakalanmamış promise
      // reddi oluşur ve bildirim sinyalleri sessizce durur.
      const warn = (name: string) => (reason: unknown) => {
        console.warn(`[ww] ${name} sinyali alınamadı: ${String(reason)}`);
      };
      void loadSignal(fetchProviders, setProviderList, () => active, warn('sağlayıcı'));
      if (!projectId) return;
      void loadSignal(
        () => fetchBudgetReport(projectId), setBudgetReport, () => active, warn('kontör'),
      );
      void loadSignal(
        () => fetchAuditReport(projectId), setAuditReport, () => active, warn('denetim'),
      );
    };
    load();
    const timer = window.setInterval(load, SIGNAL_POLL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [projectId]);

  const statusCounts = useMemo(() => countTaskStatuses(tasks), [tasks]);

  /**
   * docs/10: "aktif ekran bağlamı emre iliştirilir". Bağlamsız emir
   * ("gördüğüm şu ekranda X'i değiştir") PM için anlamsızdır ve soru sormak
   * zorunda bırakır — her soru bir tur ve bir model çağrısı demektir.
   */
  const sendCommand = useCallback(async (screenContext = '') => {
    if (!projectId || message.trim() === '') return;
    setMessageStatus('Gönderiliyor…');
    try {
      await sendUserCommand(projectId, withScreenContext(message, screenContext));
      setMessage('');
      setMessageStatus('Mesaj gönderildi');
    } catch (reason) {
      setMessageStatus(errorText(reason, 'Mesaj gönderilemedi'));
    }
  }, [projectId, message]);


  const askNarrator = useCallback(async () => {
    if (!projectId || narratorQuestion.trim() === '') return;
    try {
      setNarratorResult(await askNarratorService(projectId, narratorQuestion));
    } catch {
      setNarratorResult(null);
    }
  }, [projectId, narratorQuestion]);

  const updateProjectStatus = useCallback(async (status: 'paused' | 'running' | 'archived') => {
    try {
      await updateProjectStatusService(projectId, status);
      setProjectStatus(status);
    } catch (reason) {
      setProjectStatusMessage(errorText(reason, 'Durum değiştirilemedi'));
    }
  }, [projectId]);

  const createProject = useCallback(async () => {
    try {
      const project = await createProjectService({
        name: projectDraft.name, type: projectDraft.type, budgetUsd: projectDraft.budget,
      });
      setProjects((current) => [...current, project]);
      setProjectId(project.project_id);
      setProjectStatusMessage('Proje oluşturuldu.');
    } catch (reason) {
      setProjectStatusMessage(errorText(reason, 'Proje oluşturulamadı'));
    }
  }, [projectDraft]);

  return {
    page, setPage,
    projectId, setProjectId,
    budgetReport, auditReport, providerList,
    tasks, projects, projectsError, workspaceError, projectDraft, setProjectDraft,
    projectStatusMessage, projectStatus,
    usage, files, providerHealth, apiArtifacts,
    selectedFile, setSelectedFile,
    events, connection, statusCounts,
    timelineCursor, setTimelineCursor,
    selectedAgent, setSelectedAgent,
    replay: replayAt(events, timelineCursor),
    message, setMessage, messageStatus,
    narratorQuestion, setNarratorQuestion, narratorResult,
    tab, setTab,
    sendCommand, askNarrator, updateProjectStatus, createProject,
  };
}
