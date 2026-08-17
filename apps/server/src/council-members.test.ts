import { describe, expect, it } from 'vitest';
import { CouncilMemberError, composeCouncil } from './council-members.js';

const agent = (n: number, modelRef: string) => ({
  agentId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as never,
  modelRef,
});

describe('composeCouncil', () => {
  it('uc ayri saglayicidan uye secer', () => {
    const composition = composeCouncil([
      agent(1, 'deepseek:deepseek-chat'),
      agent(2, 'openai:gpt-5'),
      agent(3, 'anthropic:claude-sonnet-5'),
    ]);

    expect(composition.members).toHaveLength(3);
    expect(composition.distinctProviders).toBe(3);
    expect(composition.diversityWarning).toBe('');
  });

  // Konseyin amacı ÇAPRAZ KONTROL: her sağlayıcıdan önce birer üye alınmalı,
  // yoksa aynı modelin üç kopyası kendi kendini onaylar.
  it('ayni saglayicinin kopyalarindan once farkli saglayiciyi alir', () => {
    const composition = composeCouncil([
      agent(1, 'deepseek:deepseek-chat'),
      agent(2, 'deepseek:deepseek-chat'),
      agent(3, 'deepseek:deepseek-reasoner'),
      agent(4, 'openai:gpt-5'),
    ]);

    const providers = composition.members.map((m) => m.modelRef.split(':')[0]);
    expect(providers.slice(0, 2)).toEqual(['deepseek', 'openai']);
  });

  it('en fazla dort uye secer', () => {
    const composition = composeCouncil([
      agent(1, 'a:m'), agent(2, 'b:m'), agent(3, 'c:m'), agent(4, 'd:m'), agent(5, 'e:m'),
    ]);
    expect(composition.members).toHaveLength(4);
  });

  // TEK SAĞLAYICI: koşu yapılabilir ama çapraz kontrol gerçek değildir.
  // Bunu sessizce geçmek, olmayan bir güvence vermek olurdu.
  it('tek saglayiciya dusunce acikca uyarir', () => {
    const composition = composeCouncil([
      agent(1, 'deepseek:deepseek-chat'),
      agent(2, 'deepseek:deepseek-reasoner'),
      agent(3, 'deepseek:deepseek-chat'),
    ]);

    expect(composition.members).toHaveLength(3);
    expect(composition.distinctProviders).toBe(1);
    expect(composition.diversityWarning).toMatch(/çapraz kontrol bu koşuda tam değildir/);
  });

  it('tek saglayicida farkli modelleri tercih eder', () => {
    const composition = composeCouncil([
      agent(1, 'deepseek:deepseek-chat'),
      agent(2, 'deepseek:deepseek-chat'),
      agent(3, 'deepseek:deepseek-reasoner'),
    ]);
    expect(composition.members.map((m) => m.modelRef)).toContain('deepseek:deepseek-reasoner');
  });

  // Üç üye toplanamıyorsa konsey KURULMAZ: iki kişilik "konsey" protokolün
  // tur/sentez yapısını da bozar.
  it('uc uye toplanamazsa hata verir', () => {
    expect(() => composeCouncil([agent(1, 'a:m'), agent(2, 'b:m')]))
      .toThrow(CouncilMemberError);
  });

  it('model atanmamis agentlari saymaz', () => {
    expect(() => composeCouncil([
      agent(1, 'a:m'), agent(2, 'b:m'), agent(3, ''),
    ])).toThrow(/en az 3 uye/);
  });

  // ASIL KUSUR: ilk canlı konsey koşusunda üyelerden biri `mock:pm` oldu.
  // Taklit sağlayıcı ağ çağrısı yapmaz; "itirazı" senaryodan gelir. Onu üye
  // saymak, konseyin çapraz kontrol yaptığı yalanını söyler.
  it('taklit saglayicidaki uyeyi konseye almaz', () => {
    const composition = composeCouncil([
      agent(1, 'deepseek:deepseek-chat'),
      agent(2, 'mock:pm'),
      agent(3, 'openai:gpt-5'),
      agent(4, 'anthropic:claude-sonnet-5'),
    ], { stubProviders: ['mock'] });

    expect(composition.members.map((m) => m.modelRef)).not.toContain('mock:pm');
    expect(composition.members).toHaveLength(3);
  });

  // Taklitleri eledikten sonra üç üye kalmıyorsa konsey KURULMAZ: sahte
  // üyeyle kurulan konsey, hiç kurulmayandan daha yanıltıcıdır.
  it('taklitler elenince uye kalmazsa acik hata verir', () => {
    expect(() => composeCouncil([
      agent(1, 'deepseek:deepseek-chat'),
      agent(2, 'mock:pm'),
      agent(3, 'mock:worker'),
    ], { stubProviders: ['mock'] })).toThrow(/en az 3 uye/);
  });

  it('taklit listesi verilmezse eskisi gibi davranir', () => {
    expect(composeCouncil([
      agent(1, 'deepseek:deepseek-chat'), agent(2, 'mock:pm'), agent(3, 'openai:gpt-5'),
    ]).members).toHaveLength(3);
  });
});
