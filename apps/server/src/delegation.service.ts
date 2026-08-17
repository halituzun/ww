// Delegasyon uygulama katmanı (docs/03 → her agent alt görev açabilir).
//
// NEDEN VAR: `DelegationService` derinlik/bütçe/döngü korumalarıyla yazılmıştı
// ama hiçbir üretim yolu onu çağırmıyordu — delegasyon ürün olarak YOKTU.
// Ayrıca servis yalnızca ClickHouse satırını yaratır, KUYRUĞA KOYMAZ: bu
// haliyle alt görev 'queued' görünür ama hiçbir tüketici onu görmez.
import { z } from 'zod';
import { AGENT_GROUPS, EntityIdSchema } from '@ww/shared';

const SubtaskInput = z.strictObject({
  title: z.string().trim().min(1),
  description: z.string().default(''),
  acceptanceCriteria: z.array(z.string().trim().min(1)).default([]),
  targetFiles: z.array(z.string().trim().min(1)).default([]),
  group: z.enum(AGENT_GROUPS),
  budget: z.number().int().nonnegative(),
  dependencies: z.array(EntityIdSchema).default([]),
});

export type SubtaskInputValue = z.infer<typeof SubtaskInput>;

export const parseSubtaskInput = (value: unknown): SubtaskInputValue => SubtaskInput.parse(value);

export interface DelegationPorts {
  createSubtask(input: unknown): Promise<{ task_id: string; project_id: string }>;
  enqueue(projectId: string, taskId: string): Promise<unknown>;
}

/**
 * Alt görevi yaratır ve KUYRUĞA KOYAR. Kuyruğa koymamak, görevi ClickHouse'da
 * 'queued' bırakıp hiçbir tüketicinin görmemesine yol açar; kurtarma onu
 * eninde sonunda toplasa da doğru yer burasıdır.
 */
export async function createAndEnqueueSubtask(
  ports: DelegationPorts,
  input: unknown,
): Promise<{ task_id: string; project_id: string }> {
  const task = await ports.createSubtask(input);
  await ports.enqueue(task.project_id, task.task_id);
  return task;
}
