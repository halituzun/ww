// Proje kapsamlı IO katmanı (MVVM: Model/Service).
// docs/09: View'da fetch yasaktır; App.tsx'teki ham çağrılar buraya taşındı.
import { getJson, getJsonOr, requestJson, type RequestOptions } from './http.js';

export interface Project {
  project_id: string;
  name: string;
  status: string;
  type: string;
}

export interface Task {
  task_id: string;
  title: string;
  status: string;
  priority: number;
  updated_at: string;
  target_files?: string[];
  /** Tuval oklarının gerçek kaynağı: bağımlılık ve delegasyon (docs/08). */
  depends_on?: string[];
  parent_task_id?: string;
}

export interface Usage {
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  calls: number;
}

export interface FileIndex {
  file_path: string;
  summary: string;
  layer: string;
  exports: string[];
  related_task_ids: string[];
  /** Bu dosyayı üreten çıktı kayıtları (docs/08 fihrist). */
  related_artifact_ids?: string[];
  /** Bu dosyayı doğuran işlerde alınan kararlar (docs/08 fihrist). */
  related_knowledge_ids?: string[];
  last_commit_hash: string;
  change_count: number;
  updated_at: string;
}

export interface ArtifactDetail {
  artifactId: string;
  taskId: string;
  type: string;
  name: string;
  path: string;
  summary: string;
  commitHash: string;
  createdAt: string;
}

export const fetchArtifact = (
  projectId: string,
  artifactId: string,
  options: RequestOptions = {},
): Promise<ArtifactDetail> =>
  getJson<ArtifactDetail>(scope(projectId, `/artifacts/${artifactId}`), options,
    'Çıktı kaydı alınamadı');

export interface KnowledgeEntry {
  knowledge_id: string;
  kind: string;
  title: string;
}

/** Projenin aktif bilgi kayıtları (docs/06 kararlar/kısıtlar/gereksinimler). */
export const fetchKnowledge = (
  projectId: string,
  options: RequestOptions = {},
): Promise<KnowledgeEntry[]> =>
  getJson<KnowledgeEntry[]>(scope(projectId, '/knowledge'), options,
    'Karar kayıtları alınamadı');

export interface ProviderHealth {
  provider_id: string;
  health_status: string;
  last_health_check: string;
}

export interface ApiArtifact {
  artifact_id: string;
  name: string;
  path: string;
  summary: string;
  commit_hash: string;
}

export interface NarratorAnswer {
  answer: string;
  evidenceRefs: string[];
}

export type ProjectStatusChange = 'paused' | 'running' | 'archived';

export interface CreateProjectInput {
  name: string;
  type: string;
  budgetUsd: string;
}

const scope = (projectId: string, path = ''): string =>
  `/projects/${encodeURIComponent(projectId)}${path}`;

/* --------------------------------- okuma --------------------------------- */
// Okuma uçları panelin akışını kesmemeli: hata durumunda boş sonuç dönerler.

/**
 * HATAYI YUTMAZ. Boş dizi döndürmek ProjectPicker'a "Henüz proje yok —
 * yukarıdan ilkini oluşturun" dedirtiyordu: kullanıcı var olan projelerini
 * kaybettiğini sanıp kopyasını açabilirdi. "Proje yok" ile "liste alınamadı"
 * aynı şey değildir (bkz. fetchAuditReport, fetchBudgetReport).
 */
export const fetchProjects = (options: RequestOptions = {}): Promise<Project[]> =>
  getJson<Project[]>('/projects', options);

export const fetchProject = (projectId: string, options: RequestOptions = {}): Promise<Project | null> =>
  getJsonOr<Project | null>(scope(projectId), null, options);

// HATAYI YUTMAZ: boş dizi döndürmek panele "henüz görev/dosya yok" dedirtir
// ve bu, veri gelmediğinde YALAN olur (bkz. fetchProjects).
export const fetchTasks = (projectId: string, options: RequestOptions = {}): Promise<Task[]> =>
  getJson<Task[]>(scope(projectId, '/tasks'), options);

// HATAYI YUTMAZ: kontör verisi gelmediğinde hiçbir şey çizilmiyordu ve
// "harcama yok" ile "harcama bilinmiyor" aynı görünüyordu.
export const fetchUsage = (projectId: string, options: RequestOptions = {}): Promise<Usage | null> =>
  getJson<Usage | null>(scope(projectId, '/usage'), options);

export const fetchFiles = (projectId: string, options: RequestOptions = {}): Promise<FileIndex[]> =>
  getJson<FileIndex[]>(scope(projectId, '/files'), options);

// HATAYI YUTMAZ: boş dizi hiç rozet çizdirmiyordu ve rozetin YOKLUĞU
// "her şey yolunda" diye okunuyordu — docs/04 düşen sağlayıcının panelde
// kırmızı görünmesini ister.
export const fetchProviderHealth = (projectId: string, options: RequestOptions = {}): Promise<ProviderHealth[]> =>
  getJson<ProviderHealth[]>(scope(projectId, '/provider-health'), options);

// HATAYI YUTMAZ: boş liste API konsoluna "bu projede uç yok" dedirtiyordu.
export const fetchApiArtifacts = (projectId: string, options: RequestOptions = {}): Promise<ApiArtifact[]> =>
  getJson<ApiArtifact[]>(scope(projectId, '/artifacts?type=api_endpoint'), options);

/* --------------------------------- yazma --------------------------------- */
// Yazma uçları sessizce yutmaz: hata çağırana döner, ViewModel kullanıcıya gösterir.

export const updateProjectStatus = (
  projectId: string,
  status: ProjectStatusChange,
  options: RequestOptions = {},
): Promise<Project> =>
  requestJson<Project>(scope(projectId, '/status'),
    { ...options, method: 'PATCH', body: { status } }, 'Proje durumu değiştirilemedi');

export async function sendUserCommand(
  projectId: string,
  text: string,
  options: RequestOptions = {},
): Promise<void> {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error('Mesaj boş olamaz');
  await requestJson(scope(projectId, '/messages'),
    { ...options, method: 'POST', body: { kind: 'user_command', text: trimmed } },
    'Mesaj gönderilemedi');
}

export async function createProject(
  input: CreateProjectInput,
  options: RequestOptions = {},
): Promise<Project> {
  const name = input.name.trim();
  if (name.length === 0) throw new Error('Proje adı zorunludur');
  return requestJson<Project>('/projects', {
    ...options,
    method: 'POST',
    // bootstrapAgents: panelden açılan projeye agent kadrosunu kurdurur.
    body: { name, type: input.type, budgetUsdLimit: Number(input.budgetUsd) || 0, bootstrapAgents: true },
  }, 'Proje oluşturulamadı');
}

export const askNarrator = (
  projectId: string,
  question: string,
  options: RequestOptions = {},
): Promise<NarratorAnswer> =>
  requestJson<NarratorAnswer>(scope(projectId, '/narrator'),
    { ...options, method: 'POST', body: { question } }, 'Narrator yanıt vermedi');

export { getJson };
