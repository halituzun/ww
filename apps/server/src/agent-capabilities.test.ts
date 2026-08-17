import { describe, expect, it } from 'vitest';
import { buildAgentCapabilities } from './agent-capabilities.js';

const agent = (id: string, role: string) => ({ agent_id: id, role, status: 'idle' });
const projectId = '00000000-0000-4000-8000-000000000001';

describe('buildAgentCapabilities', () => {
  // ASIL KUSUR: yetenek haritası üretimde hiç doldurulmuyordu; hiçbir agent
  // kimlik doğrulayamıyor, worker raporu 'system' olarak gönderilmeye
  // çalışılıp "routing matrisinde system gonderici rotasi yoktur" ile
  // reddediliyordu.
  it('her agent için bir kimlik bilgisi üretir', () => {
    const built = buildAgentCapabilities(projectId as never, [
      agent('a1', 'worker'), agent('a2', 'verifier'),
    ] as never);

    expect(built.capabilities.size).toBe(2);
    expect(built.credentialFor('a1' as never)).toBeDefined();
    expect(built.credentialFor('a2' as never)).toBeDefined();
  });

  it('kimlik bilgisi doğru agent’a ve projeye bağlanır', () => {
    const built = buildAgentCapabilities(projectId as never, [agent('a1', 'worker')] as never);
    const credential = built.credentialFor('a1' as never)!;

    expect(built.capabilities.get(credential)).toEqual({ projectId, agentId: 'a1' });
  });

  // Aynı kimlik bilgisi iki agent'a düşerse biri diğerinin yerine geçebilir.
  it('agent’lara farklı kimlik bilgileri verir', () => {
    const built = buildAgentCapabilities(projectId as never, [
      agent('a1', 'worker'), agent('a2', 'verifier'),
    ] as never);

    expect(built.credentialFor('a1' as never)).not.toBe(built.credentialFor('a2' as never));
  });

  // Durdurulmuş agent adına mesaj gönderilememeli.
  it('durdurulmuş agent’ı atlar', () => {
    const built = buildAgentCapabilities(projectId as never, [
      { agent_id: 'a1', role: 'worker', status: 'stopped' },
    ] as never);

    expect(built.capabilities.size).toBe(0);
    expect(built.credentialFor('a1' as never)).toBeUndefined();
  });

  it('bilinmeyen agent için kimlik bilgisi dönmez', () => {
    const built = buildAgentCapabilities(projectId as never, [agent('a1', 'worker')] as never);
    expect(built.credentialFor('yok' as never)).toBeUndefined();
  });

  it('agent yoksa boş harita döner', () => {
    expect(buildAgentCapabilities(projectId as never, [] as never).capabilities.size).toBe(0);
  });
});
