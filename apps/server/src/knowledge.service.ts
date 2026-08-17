// Proje bilgisi girdisi (docs/06 → "asla unutmama" çekirdeği).
//
// NEDEN VAR: Context Builder artık `knowledge` tablosunu OKUYOR ama hiçbir
// üretim yolu ona YAZMIYORDU: tablo boştu, dolayısıyla bağlam paketinin
// "proje kararları ve kısıtları" bölümü daima boş kalacaktı. Okunan ama
// yazılmayan bir hafıza, hafıza değildir.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { KNOWLEDGE_KINDS, EntityIdSchema } from '@ww/shared';

const KnowledgeInput = z.strictObject({
  kind: z.enum(KNOWLEDGE_KINDS),
  title: z.string().trim().min(1).max(400),
  content: z.string().trim().min(1).max(100_000),
  tags: z.array(z.string().trim().min(1)).default([]),
  sourceTaskId: EntityIdSchema.optional(),
  sourceMessageId: EntityIdSchema.optional(),
});

export type KnowledgeInputValue = z.infer<typeof KnowledgeInput>;

export const parseKnowledgeInput = (value: unknown): KnowledgeInputValue =>
  KnowledgeInput.parse(value);

const NIL = '00000000-0000-0000-0000-000000000000';

export function buildKnowledgeRow(
  projectId: string,
  input: KnowledgeInputValue,
  now: string,
): Record<string, unknown> {
  return {
    knowledge_id: randomUUID(),
    project_id: projectId,
    kind: input.kind,
    title: input.title,
    content: input.content,
    tags: [...input.tags],
    // Kaynağı olan bilgi izlenebilir olur: "bu kararı hangi iş doğurdu".
    source_task_id: input.sourceTaskId ?? NIL,
    source_message_id: input.sourceMessageId ?? NIL,
    status: 'active',
    superseded_by: NIL,
    created_at: now,
  };
}
