// `Phase1RuntimeContextPort` üretim karşılığı: mühürlü prompt girdisi üretir.
//
// Brief atama anında mühürlendiği için kaynak sürümleri, prompt referansları
// ve kabul kriterleri zaten sabittir; bu servis onlardan modele gidecek
// girdiyi kurar ve mührü (promptHash) hesaplar.
import { randomUUID } from 'node:crypto';
import { canonicalSha256V1 } from '@ww/shared';
import type { AssignmentAttemptV1, EntityId, PromptInputSnapshotV1, TaskBriefV1 } from '@ww/shared';
import { assemblePromptMessages } from './prompt-assembly.js';

export interface PromptLoaderPort {
  /** Brief'in promptRefs'iyle sabitlenmiş şablonu getirir. */
  load(name: string, version: number): Promise<string | null>;
}

export interface RuntimeContextInput {
  prompts: PromptLoaderPort;
  workspaceRoot: string;
  models: { workerModelRef: string; verifierModelRef: string };
  /** docs/06 Context Builder çıktısı. */
  loadContextPack: (input: Readonly<{ brief: TaskBriefV1 }>) => Promise<string>;
  /**
   * Mühürlü girdiyi KALICI yazar. Verilmezse mühür yalnızca bellekte kalır ve
   * `api_usage.prompt_input_snapshot_id` var olmayan bir kayda işaret eder —
   * canlı veritabanında tam olarak bu durumdaydı: 216 çağrı bir anlık
   * görüntüye atıf yapıyordu, tablo boştu. "Bu çıktıyı hangi prompt üretti"
   * sorusunun cevabı yoktu.
   */
  persistSnapshot?: (snapshot: PromptInputSnapshotV1) => Promise<unknown>;
  /**
   * Görevin nedensel imleci (docs/06 → provenance). Verilmezse 0 varsayılır.
   *
   * NEDEN VAR: imleç SABİT 0 yazılıyordu; yani her mühür "bu agent daha önce
   * hiçbir şey görmedi" diyordu. Görevin gerçekten işlediği önceki girdiler
   * varken bu iddia yanlıştır ve replay yanlış noktadan başlar.
   */
  loadCausalOrdinal?: (input: Readonly<{
    taskId: EntityId;
    assignmentAttemptId: EntityId;
  }>) => Promise<number>;
}

export function createRuntimeContextService(input: RuntimeContextInput) {
  return {
    async load({ brief, attempt }: Readonly<{ brief: TaskBriefV1; attempt: AssignmentAttemptV1 }>) {
      const refs = (brief as unknown as {
        promptRefs: readonly { sourceId: string; version: number }[];
        sourceVersionManifest: unknown;
      });
      const primary = refs.promptRefs[0];
      if (primary === undefined) throw new Error('brief prompt referansı taşımıyor');

      const template = await input.prompts.load(primary.sourceId, primary.version);
      if (template === null) {
        throw new Error(`prompt bulunamadı: ${primary.sourceId} v${primary.version}`);
      }

      const contextPack = await input.loadContextPack({ brief });
      const taskId = (brief as unknown as { taskId: EntityId }).taskId;
      // Gerçek imleç okunur; kayıt yoksa 0 DOĞRUDUR (henüz hiçbir girdi
      // işlenmemiştir), uydurma değildir.
      const cursorOrdinal = input.loadCausalOrdinal === undefined
        ? 0
        : await input.loadCausalOrdinal({
          taskId,
          assignmentAttemptId: attempt.assignmentAttemptId,
        });
      const promptMessages = assemblePromptMessages({ brief, template, contextPack });

      const snapshot = {
        contractVersion: 1,
        promptInputSnapshotId: randomUUID() as EntityId,
        // Her yükleme ayrı bir model çağrısıdır; paylaşılan invocationId
        // iki çağrıyı tek olay gibi gösterip kontörü ve izi bozar.
        invocationId: randomUUID() as EntityId,
        projectId: attempt.projectId,
        taskId,
        taskBriefId: attempt.taskBriefId,
        assignmentAttemptId: attempt.assignmentAttemptId,
        // Şema cursor'un aynı attempt içinde kalmasını zorunlu kılar.
        inputTaskCausalCursor: {
          assignmentAttemptId: attempt.assignmentAttemptId,
          ordinal: cursorOrdinal,
        },
        sourceVersionManifest: refs.sourceVersionManifest,
        promptMessages,
        // Mühür: şema promptHash'in mesajlarla eşleşmesini zorunlu kılar.
        promptHash: canonicalSha256V1(promptMessages),
        sealedAt: new Date().toISOString(),
      } as unknown as PromptInputSnapshotV1;

      // Mühür sözleşmedir: yazılamazsa çağrı da yapılmamalıdır, yoksa
      // provenance iddiası yalan olur.
      if (input.persistSnapshot !== undefined) await input.persistSnapshot(snapshot);

      return {
        snapshot,
        workspaceRoot: input.workspaceRoot,
        workerModelRef: input.models.workerModelRef,
        verifierModelRef: input.models.verifierModelRef,
      };
    },
  };
}
