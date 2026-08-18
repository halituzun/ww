import { EntityIdSchema, type AssignmentAttemptV1, type EntityId, type StructuredVerdictV1, type TaskBriefV1, type TaskStatus } from '@ww/shared';
import { BrakeError } from './safety-brakes.js';

/** Narrow bridge owned by server composition; scheduler does not import agents. */
export interface Phase1RuntimePort {
  work(input: Readonly<{ brief: TaskBriefV1; attempt: AssignmentAttemptV1 }>): Promise<Readonly<{ kind: 'question' | 'report' | 'failure'; summary?: string; question?: string; questionMessageId?: EntityId; detail?: string }>>;
  verify(input: Readonly<{ brief: TaskBriefV1; attempt: AssignmentAttemptV1; summary: string }>): Promise<Readonly<{ verdict: StructuredVerdictV1; diff: string }>>;
}

export interface Phase1SchedulerPort {
  assign(taskId: EntityId): Promise<AssignmentAttemptV1>;
  awaitUserAnswer(input: Readonly<{ taskId: EntityId; attempt: AssignmentAttemptV1; question: string; questionMessageId?: EntityId }>): Promise<void>;
  resumeUserAnswer(input: Readonly<{ projectId: EntityId; taskId: EntityId; taskBriefId: EntityId; previousAttemptId: EntityId; questionMessageId: EntityId; replyMessageId: EntityId; answer: string }>): Promise<AssignmentAttemptV1>;
  handleExecutionError(input: Readonly<{ taskId: EntityId; attempt: AssignmentAttemptV1; phase: 'working' | 'verifying' | 'testing' | 'committing'; error: unknown }>): Promise<TaskStatus>;
  transition(input: Readonly<{ taskId: EntityId; attempt: AssignmentAttemptV1; action: 'start_work' | 'report_result' | 'verifier_approved' | 'verifier_rejected' | 'gate_passed' | 'gate_failed' | 'commit_completed' | 'fail'; evidenceRefs?: readonly string[]; resultSummary?: string }>): Promise<Readonly<{ status: TaskStatus }>>;
  reassign(input: Readonly<{ taskId: EntityId; reason: 'retry_after_rejection' | 'retry_after_gate_failure'; evidenceRefs: readonly string[] }>): Promise<AssignmentAttemptV1>;
  escalate(input: Readonly<{ taskId: EntityId; attempt: AssignmentAttemptV1; reason: string }>): Promise<void>;
  gate(input: Readonly<{ taskId: EntityId; attempt: AssignmentAttemptV1; targetFiles?: readonly string[] }>): Promise<Readonly<{ passed: boolean; evidenceRefs: readonly string[]; failureSummary?: string }>>;
  commit(input: Readonly<{ taskId: EntityId; attempt: AssignmentAttemptV1 }>): Promise<Readonly<{ commitHash: string }>>;
  /**
   * docs/05 yarım iş kuralı: "Ret/iptal/kurtarma → git checkout . &&
   * git clean -fd". Reddedilen denemenin dosyaları diskte kalırsa yeni
   * worker, prompt'unda YAZMAYAN bir kodun üstüne yazar: temiz sanıp
   * ekleyince yinelenen kod ya da yarım birleşim çıkar.
   *
   * İSTEĞE BAĞLI: bağlanmamışsa akış eskisi gibi çalışır — isteğe bağlı
   * yetenek zorunlu bağımlılığa dönüşmemeli.
   */
  resetWorkspace?(input: Readonly<{ taskId: EntityId; attempt: AssignmentAttemptV1 }>): Promise<void>;
}

export interface Phase1OrchestratorInput {
  readonly brakes?: Phase1BrakeCheck | undefined;
  readonly taskId: EntityId;
  /**
   * Çağıranın brief'i. `loadBrief` verilmişse GEREKSİZDİR: bağlayıcı brief
   * atamanın mühürlediğidir. Çağıranın ayrıca mühürlemesi, agent seçimini de
   * bozuyordu (seçim worker'ın prompt'unun brief'le eşleşmesini ister).
   */
  readonly brief?: TaskBriefV1;
  /**
   * Atamanın FİİLEN bağladığı brief'i yükler. İlk atama brief'i kendi
   * mühürler (agent prompt sürümleri + kendi cutoff'u); çağıranın ayrıca
   * mühürlediği brief onunla asla eşleşmez ve worker raporu
   * "task brief uyusmuyor" ile reddedilir.
   */
  readonly loadBrief?: (attempt: AssignmentAttemptV1) => Promise<TaskBriefV1>;
  readonly scheduler: Phase1SchedulerPort;
  readonly runtime: Phase1RuntimePort;
  readonly maxAttempts?: number;
}
/**
 * Denemeye başlamadan önce çalışan güvenlik freni (docs/07 → Frenler).
 * Fren tetiklenirse BrakeError fırlatır; orkestratör işi başlatmadan tırmandırır.
 */
export type Phase1BrakeCheck = (context: Readonly<{
  taskId: EntityId;
  attempt: AssignmentAttemptV1;
  attemptNumber: number;
}>) => Promise<void>;

export interface Phase1OrchestratorResult { readonly status: TaskStatus; readonly attempts: number; readonly commitHash?: string; }
export interface Phase1ResumeInput extends Omit<Phase1OrchestratorInput, 'taskId'> { readonly taskId: EntityId; readonly replyMessageId: EntityId; readonly answer: string; readonly questionMessageId: EntityId; readonly previousAttemptId: EntityId; }
export class Phase1OrchestratorError extends Error { constructor(message: string) { super(message); this.name = 'Phase1OrchestratorError'; } }

function boundedAttempts(value: number | undefined): number {
  const attempts = value ?? 3;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 3) throw new Phase1OrchestratorError('maxAttempts 1 ile 3 arasında güvenli tam sayı olmalıdır');
  return attempts;
}

async function runAssignedLifecycle(input: Phase1OrchestratorInput & { brief: TaskBriefV1 }, initialAttempt: AssignmentAttemptV1, maxAttempts: number, initialCount: number, alreadyWorking = false, phase?: { current: 'working' | 'verifying' | 'testing' | 'committing' }): Promise<Phase1OrchestratorResult> {
  let attempt = initialAttempt;
  for (let attempts = initialCount; attempts <= maxAttempts; attempts += 1) {
    if (phase !== undefined) phase.current = 'working';
    // Fren, iş BAŞLAMADAN kontrol edilir: tetiklenmişse token/para harcanmaz.
    if (input.brakes !== undefined) {
      try {
        await input.brakes({ taskId: input.taskId, attempt, attemptNumber: attempts });
      } catch (error) {
        if (!(error instanceof BrakeError)) throw error; // gerçek hata yutulmaz
        await input.scheduler.escalate({
          taskId: input.taskId, attempt, reason: `brake:${error.kind}: ${error.message}`,
        });
        return { status: 'escalated', attempts };
      }
    }
    if (!(alreadyWorking && attempts === initialCount)) {
      await input.scheduler.transition({ taskId: input.taskId, attempt, action: 'start_work' });
    }
    const work = await input.runtime.work({ brief: input.brief, attempt });
    if (work.kind === 'question') {
      if (work.question === undefined || work.question.trim() === '') throw new Phase1OrchestratorError('worker sorusu boş olamaz');
      if (work.questionMessageId !== undefined) EntityIdSchema.parse(work.questionMessageId);
      await input.scheduler.awaitUserAnswer({ taskId: input.taskId, attempt, question: work.question, ...(work.questionMessageId === undefined ? {} : { questionMessageId: work.questionMessageId }) });
      return { status: 'waiting_user', attempts };
    }
    if (work.kind === 'failure') {
      // Sebep geçişe yazılır; yoksa görev "neden düştü" bilinmeden kapanır.
      await input.scheduler.transition({
        taskId: input.taskId,
        attempt,
        action: 'fail',
        ...(work.detail === undefined ? {} : { resultSummary: work.detail }),
      });
      return { status: 'failed', attempts };
    }
    if (work.summary === undefined || work.summary.trim() === '') throw new Phase1OrchestratorError('worker raporu boş olamaz');
    await input.scheduler.transition({ taskId: input.taskId, attempt, action: 'report_result' });
    if (phase !== undefined) phase.current = 'verifying';
    const checked = await input.runtime.verify({ brief: input.brief, attempt, summary: work.summary });
    if (checked.verdict.decision === 'reject') {
      if (attempts >= maxAttempts) {
        await input.scheduler.escalate({ taskId: input.taskId, attempt, reason: 'verifier third persistent rejection' });
        return { status: 'escalated', attempts };
      }
      // Reddi ÖNCE duruma yaz: 'verifier_rejected' görevi verifying'den
      // working'e döndürür ve reassign working görev ister. Bu geçiş
      // atlandığı için yeniden deneme "reassignment working task gerektirir"
      // ile düşüyordu — yani verifier reddettiğinde görev ASLA yeniden
      // denenemiyordu.
      // Gerekçeler `tasks.reject_reason`'a yazılır ve sonraki denemenin
      // prompt'una girer. Geçilmediğinde geçiş katmanı sabit "verifier işi
      // reddetti" yazıyordu: reddedilen worker neyi düzelteceğini asla
      // öğrenemiyor ve aynı işi tekrar üretiyordu. HEPSİ taşınır — yalnız
      // ilkini almak diğer ihlalleri gizler.
      const verdictReason = checked.verdict.reasons
        .map((reason) => reason.message.trim())
        .filter((message) => message !== '')
        .join('\n');
      await input.scheduler.transition({
        taskId: input.taskId, attempt, action: 'verifier_rejected',
        evidenceRefs: checked.verdict.evidenceRefs,
        ...(verdictReason === '' ? {} : { resultSummary: verdictReason }),
      });
      // docs/05: reddedilen denemenin dosyaları diskte kalmaz. Temizlik
      // BAŞARISIZ olursa yeniden deneme yine yapılır: kirli ağaç kötüdür ama
      // hiç denememek daha kötüdür.
      await input.scheduler.resetWorkspace?.({ taskId: input.taskId, attempt })
        .catch(() => undefined);
      attempt = await input.scheduler.reassign({ taskId: input.taskId, reason: 'retry_after_rejection', evidenceRefs: checked.verdict.evidenceRefs });
      continue;
    }
    await input.scheduler.transition({ taskId: input.taskId, attempt, action: 'verifier_approved', evidenceRefs: checked.verdict.evidenceRefs });
    // Kapı görevin hedef dosyalarını görmeli: statik ww.gate.json gelecekteki
    // dosyaları bilemez ve her girdi DOSYA olarak okunur (dizin geçersiz).
    if (phase !== undefined) phase.current = 'testing';
    const gate = await input.scheduler.gate({
      taskId: input.taskId,
      attempt,
      targetFiles: (input.brief as unknown as { targetFiles?: readonly string[] }).targetFiles ?? [],
    });
    if (!gate.passed) {
      if (attempts >= maxAttempts) {
        await input.scheduler.escalate({ taskId: input.taskId, attempt, reason: 'gate failed at attempt limit' });
        return { status: 'escalated', attempts };
      }
      // Aynı kural kapı için: 'gate_failed' testing'den working'e döndürür.
      // Sebep `tasks.reject_reason`'a yazılır ve sonraki denemenin prompt'una
      // girer; verilmezse sabit "kapı adımı geçilemedi" yazılıyordu ve worker
      // neyi düzelteceğini asla öğrenemiyordu.
      const gateReason = gate.failureSummary?.trim() ?? '';
      await input.scheduler.transition({
        taskId: input.taskId, attempt, action: 'gate_failed', evidenceRefs: gate.evidenceRefs,
        ...(gateReason === '' ? {} : { resultSummary: gateReason }),
      });
      await input.scheduler.resetWorkspace?.({ taskId: input.taskId, attempt })
        .catch(() => undefined);
      attempt = await input.scheduler.reassign({ taskId: input.taskId, reason: 'retry_after_gate_failure', evidenceRefs: gate.evidenceRefs });
      continue;
    }
    await input.scheduler.transition({ taskId: input.taskId, attempt, action: 'gate_passed', evidenceRefs: gate.evidenceRefs });
    if (phase !== undefined) phase.current = 'committing';
    const commit = await input.scheduler.commit({ taskId: input.taskId, attempt });
    await input.scheduler.transition({ taskId: input.taskId, attempt, action: 'commit_completed', evidenceRefs: [commit.commitHash] });
    return { status: 'done', attempts, commitHash: commit.commitHash };
  }
  throw new Phase1OrchestratorError('orchestrator attempt sınırına ulaştı');
}

/** Executes one serial task lifecycle. All state changes remain scheduler-owned. */
export async function runPhase1Orchestrator(input: Phase1OrchestratorInput): Promise<Phase1OrchestratorResult> {
  const maxAttempts = boundedAttempts(input.maxAttempts);
  const attempt = await input.scheduler.assign(input.taskId);
  // Aşama SABİT 'working' bildiriliyordu; hata kaydedicisi FSM'de geçerli
  // eylemi aşamaya göre seçtiği için yanlış aşama görevi takılı bırakıyordu.
  const phase = { current: 'working' as 'working' | 'verifying' | 'testing' | 'committing' };
  try {
    // Brief atamadan sonra çözülür: bağlayıcı olan atamanınkidir.
    const bound = input.loadBrief === undefined ? input.brief : await input.loadBrief(attempt);
    if (bound === undefined) {
      throw new Phase1OrchestratorError('brief yok: loadBrief ya da brief verilmelidir');
    }
    return await runAssignedLifecycle({ ...input, brief: bound }, attempt, maxAttempts, 1, false, phase);
  } catch (error) {
    const status = await input.scheduler.handleExecutionError({ taskId: input.taskId, attempt, phase: phase.current, error });
    return { status, attempts: 1 };
  }
}

/** Resumes only an explicitly answered, exact pending question and starts a fresh attempt. */
export async function resumePhase1Orchestrator(input: Phase1ResumeInput): Promise<Phase1OrchestratorResult> {
  const maxAttempts = boundedAttempts(input.maxAttempts);
  const replyMessageId = EntityIdSchema.parse(input.replyMessageId);
  const questionMessageId = EntityIdSchema.parse(input.questionMessageId);
  const previousAttemptId = EntityIdSchema.parse(input.previousAttemptId);
  if (input.answer.trim() === '') throw new Phase1OrchestratorError('kullanıcı cevabı boş olamaz');
  if (replyMessageId === questionMessageId) throw new Phase1OrchestratorError('cevap mesajı soru mesajıyla aynı olamaz');
  // Devam akışı çağıranın brief'ini ZORUNLU kılar: hangi brief'e cevap
  // verildiği belirsiz kalamaz.
  const resumeBrief = input.brief;
  if (resumeBrief === undefined) {
    throw new Phase1OrchestratorError('kullanıcı cevabı akışı brief gerektirir');
  }
  const attempt = await input.scheduler.resumeUserAnswer({ projectId: resumeBrief.projectId, taskId: input.taskId, taskBriefId: resumeBrief.taskBriefId, previousAttemptId, questionMessageId, replyMessageId, answer: input.answer });
  try {
    return await runAssignedLifecycle({ ...input, brief: resumeBrief }, attempt, maxAttempts, 1, true);
  } catch (error) {
    const status = await input.scheduler.handleExecutionError({ taskId: input.taskId, attempt, phase: 'working', error });
    return { status, attempts: 1 };
  }
}
