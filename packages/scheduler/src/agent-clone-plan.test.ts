import { describe, expect, it } from 'vitest';
import { pickCloneSource } from './agent-clone-plan.js';

const agent = (id: string, over: Partial<Parameters<typeof pickCloneSource>[0][number]> = {}) => ({
  agent_id: id, role: 'worker', group: 'coding', status: 'busy',
  prompt_name: 'role.worker', prompt_version: 1, ...over,
});

const need = { role: 'worker', group: 'coding' };

describe('pickCloneSource', () => {
  // ASIL KUSUR: eşleşen tüm agent'lar meşgulken atama "idle worker
  // bulunamadi" ile düşüyordu; docs/03 bunu klonlamanın çözmesini söylüyor.
  it('tum eslesenler mesgulken klon kaynagi secer', () => {
    expect(pickCloneSource([agent('w1'), agent('w2')], need)?.agent_id).toBe('w1');
  });

  // Boşta eşleşme varsa klonlamak gereksiz agent yaratır.
  it('bosta eslesme varsa klonlamaz', () => {
    expect(pickCloneSource([agent('w1'), agent('w2', { status: 'idle' })], need)).toBeUndefined();
  });

  // Uygun rol/grup taşıyan hiçbir agent yoksa klon da uymaz.
  it('uygun rol yoksa klonlamaz', () => {
    expect(pickCloneSource([agent('v1', { role: 'verifier' })], need)).toBeUndefined();
  });

  it('uygun grup yoksa klonlamaz', () => {
    expect(pickCloneSource([agent('w1', { group: 'design' })], need)).toBeUndefined();
  });

  // Mühürlü brief belirli bir prompt sürümü isterse klon da onu taşımalıdır.
  it('prompt surumu eslesmeyeni klonlamaz', () => {
    expect(pickCloneSource([agent('w1', { prompt_version: 2 })],
      { ...need, promptName: 'role.worker', promptVersion: 1 })).toBeUndefined();
  });

  it('prompt surumu eslesen mesgulu klonlar', () => {
    expect(pickCloneSource([agent('w1')],
      { ...need, promptName: 'role.worker', promptVersion: 1 })?.agent_id).toBe('w1');
  });

  // Durdurulmuş agent'ı klonlamak, kapatılmış bir kadroyu geri getirir.
  it('durdurulmus agenti klonlamaz', () => {
    expect(pickCloneSource([agent('w1', { status: 'stopped' })], need)).toBeUndefined();
  });

  it('bos listede klonlamaz', () => {
    expect(pickCloneSource([], need)).toBeUndefined();
  });

  // Kararlı seçim: aynı girdi hep aynı kaynağı klonlar.
  it('kaynak secimi kararlidir', () => {
    expect(pickCloneSource([agent('w2'), agent('w1')], need)?.agent_id).toBe('w1');
  });
});
