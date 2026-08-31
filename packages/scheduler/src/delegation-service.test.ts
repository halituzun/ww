import { describe, expect, it } from 'vitest';
import { NIL_UUID } from '@ww/shared';
import { DelegationService } from './delegation-service.js';

const parentId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const issuerId = '33333333-3333-4333-8333-333333333333';

// Sahte veritabanı SORGUYA GÖRE cevap verir. Eskiden HER sorguya aynı satırı
// döndürüyordu; böyle bir sahte, "yanlış tabloyu okuyorum" kusurunu yapısal
// olarak göremez (deponun daha önce altı kez ısırıldığı tuzak).
function fakeDb(
  rows: readonly Record<string, unknown>[],
  usage: readonly Record<string, unknown>[] = [{ tokens: 0 }],
) {
  return {
    query: async ({ query }: { query: string }) => ({
      json: async () => (query.includes('api_usage') ? usage : rows),
    }),
  } as never;
}

describe('DelegationService bütçe ve soy ağacı sınırları', () => {
  // ASIL KUSUR: harcama parent'ın `tokens_spent` KOLONUNDAN okunuyordu ve o
  // kolona üretimde yalnızca 0 yazılır. Yani "alt görev parent'ın KALAN
  // bütçesini aşamaz" kuralı fiilen "TOPLAM bütçesini aşamaz"a dönüşüyordu:
  // bütçesini bitirmiş bir görev, her alt göreve bütçenin tamamını dağıtabilirdi.
  it('harcanmış tokenleri parent kalan bütçesinden düşer', async () => {
    const service = new DelegationService(fakeDb(
      [{ task_id: parentId, project_id: projectId, parent_task_id: NIL_UUID, delegation_depth: 0, token_budget: 10, tokens_spent: '0', issuer_agent_id: issuerId }],
      [{ tokens: 7 }],
    ));
    await expect(service.createSubtask({ parentTaskId: parentId as never, issuerAgentId: issuerId as never, title: 'too large', acceptanceCriteria: [], targetFiles: [], group: 'coding', budget: 4 })).rejects.toThrow(/kalan butcesi/);
  });

  it('parent veya dependency soy ağacına dönen cycleı reddeder', async () => {
    const service = new DelegationService(fakeDb([{ task_id: parentId, project_id: projectId, parent_task_id: NIL_UUID, delegation_depth: 0, token_budget: 10, tokens_spent: '0', issuer_agent_id: issuerId }]));
    await expect(service.createSubtask({ parentTaskId: parentId as never, issuerAgentId: issuerId as never, title: 'cycle', acceptanceCriteria: [], targetFiles: [], group: 'coding', budget: 1, dependencies: [parentId as never] })).rejects.toThrow(/cycle/);
  });

  // KAYNAK KUSUR (canlı veride bulundu): `plan_id: NIL_UUID` SABİT yazılıydı.
  // Plansız görev atamada reddedilir ("task plan kimligi tasimiyor"), yani
  // docs/03'ün çekirdek yeteneği olan `create_subtask` ile açılan HER alt
  // görev doğuştan koşamaz durumdaydı. Üstelik sessizce: görev `queued`
  // görünüyor, kuyruğa giriyor, her turda reddediliyordu.
  it('alt gorev parentin plan kimligini DEVRALIR', async () => {
    const planId = '44444444-4444-4444-8444-444444444444';
    const inserted: Record<string, unknown>[] = [];
    // İLK sorgu parent'ı döndürür; sonrakiler boş. Aksi halde createTask'ın
    // `getLatestTask` okuması da parent satırını görüp "task zaten var" der
    // ve ekleme hiç yapılmaz.
    let calls = 0;
    const db = {
      query: async () => ({ json: async () => (calls++ === 0 ? [{
        task_id: parentId, project_id: projectId, plan_id: planId,
        parent_task_id: NIL_UUID, delegation_depth: 0, token_budget: 10,
        tokens_spent: '0', issuer_agent_id: issuerId,
      }] : []) }),
      insert: async (payload: { values: Record<string, unknown>[] }) => {
        inserted.push(...payload.values);
      },
    } as never;

    await new DelegationService(db).createSubtask({
      parentTaskId: parentId as never, issuerAgentId: issuerId as never,
      title: 'alt görev', acceptanceCriteria: [], targetFiles: [],
      group: 'coding', budget: 1,
    }).catch(() => undefined);

    expect(inserted[0]?.['plan_id']).toBe(planId);
  });

  // Parent'ın planı yoksa alt görevi SESSİZCE açmak, koşamayacak bir görev
  // yaratmaktır. Açık hata, hiç çalışmayan görevden iyidir.
  it('parentin plani yoksa acik hata verir', async () => {
    const service = new DelegationService(fakeDb([{
      task_id: parentId, project_id: projectId, plan_id: NIL_UUID,
      parent_task_id: NIL_UUID, delegation_depth: 0, token_budget: 10,
      tokens_spent: '0', issuer_agent_id: issuerId,
    }]));
    await expect(service.createSubtask({
      parentTaskId: parentId as never, issuerAgentId: issuerId as never,
      title: 'plansız', acceptanceCriteria: [], targetFiles: [],
      group: 'coding', budget: 1,
    })).rejects.toThrow(/plan/);
  });
});
