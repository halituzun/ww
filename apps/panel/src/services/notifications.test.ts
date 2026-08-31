import { describe, expect, it } from 'vitest';
import { deriveNotifications, unseenCount, type NotificationSignals } from './notifications.js';

const empty: NotificationSignals = {};

describe('deriveNotifications', () => {
  it('sinyal yoksa bildirim üretmez', () => {
    expect(deriveNotifications(empty)).toEqual([]);
  });

  // docs/08: bütçe %80 ve %100 ayrı bildirim kaynaklarıdır.
  it('bütçe uyarısını ve aşımını ayırt eder', () => {
    const warn = deriveNotifications({ budget: { state: 'warning', ratio: 0.85 } });
    expect(warn).toHaveLength(1);
    expect(warn[0]).toMatchObject({ kind: 'budget', tone: 'warning' });

    const over = deriveNotifications({ budget: { state: 'exceeded', ratio: 1.2 } });
    expect(over[0]).toMatchObject({ kind: 'budget', tone: 'critical' });
  });

  it('bütçe iyiyken bildirim üretmez', () => {
    expect(deriveNotifications({ budget: { state: 'ok', ratio: 0.3 } })).toEqual([]);
    expect(deriveNotifications({ budget: { state: 'unlimited', ratio: 0 } })).toEqual([]);
  });

  it('düşen sağlayıcıyı bildirir, sağlıklıyı bildirmez', () => {
    const result = deriveNotifications({
      providers: [
        { provider_id: 'deepseek', health_status: 'down', enabled: true },
        { provider_id: 'openai', health_status: 'ok', enabled: true },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'provider', tone: 'critical' });
    expect(result[0]!.detail).toContain('deepseek');
  });

  // Pasif sağlayıcı bilinçli olarak kapatılmıştır; uyarı gürültüdür.
  it('pasif sağlayıcı için bildirim üretmez', () => {
    expect(deriveNotifications({
      providers: [{ provider_id: 'eski', health_status: 'down', enabled: false }],
    })).toEqual([]);
  });

  it('degraded sağlayıcıyı uyarı seviyesinde bildirir', () => {
    const result = deriveNotifications({
      providers: [{ provider_id: 'openai', health_status: 'degraded', enabled: true }],
    });
    expect(result[0]!.tone).toBe('warning');
  });

  it('kullanıcı cevabı bekleyen görevi bildirir', () => {
    const result = deriveNotifications({
      tasks: [
        { task_id: 't1', title: 'hangi klasör?', status: 'waiting_user' },
        { task_id: 't2', title: 'çalışıyor', status: 'working' },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'question' });
    expect(result[0]!.id).toContain('t1');
  });

  it('tırmandırmayı bildirir ve fren türünü başlıkta gösterir', () => {
    const result = deriveNotifications({
      escalations: [{ eventId: 'e1', taskId: 't9', reason: 'brake:cost_budget: asildi', brakeKind: 'cost_budget' }],
    });
    expect(result[0]).toMatchObject({ kind: 'escalation', tone: 'critical' });
    expect(result[0]!.title).toMatch(/bütçe/i);
  });

  // Kimlikler kararlı olmalı: aksi halde "görüldü" işareti her yenilemede sıfırlanır.
  it('aynı girdi için aynı kimlikleri üretir', () => {
    const signals: NotificationSignals = {
      budget: { state: 'warning', ratio: 0.9 },
      providers: [{ provider_id: 'deepseek', health_status: 'down', enabled: true }],
    };
    expect(deriveNotifications(signals).map((n) => n.id))
      .toEqual(deriveNotifications(signals).map((n) => n.id));
  });

  it('kritik bildirimleri öne alır', () => {
    const result = deriveNotifications({
      budget: { state: 'warning', ratio: 0.85 },
      providers: [{ provider_id: 'deepseek', health_status: 'down', enabled: true }],
    });
    expect(result[0]!.tone).toBe('critical');
  });

  it('aynı olayı iki kez üretmez', () => {
    const result = deriveNotifications({
      escalations: [
        { eventId: 'e1', taskId: 't9', reason: 'a', brakeKind: '' },
        { eventId: 'e1', taskId: 't9', reason: 'a', brakeKind: '' },
      ],
    });
    expect(result).toHaveLength(1);
  });
});

describe('unseenCount', () => {
  const list = [
    { id: 'a', kind: 'budget', tone: 'warning', title: 'x', detail: 'y' },
    { id: 'b', kind: 'provider', tone: 'critical', title: 'x', detail: 'y' },
  ] as never[];

  it('görülmemişleri sayar', () => {
    expect(unseenCount(list, new Set())).toBe(2);
    expect(unseenCount(list, new Set(['a']))).toBe(1);
    expect(unseenCount(list, new Set(['a', 'b']))).toBe(0);
  });

  it('artık var olmayan görüldü kaydı sayımı bozmaz', () => {
    expect(unseenCount(list, new Set(['eski-kayit']))).toBe(2);
  });

  // docs/08 bildirim merkezi. REC-004 (plansız görev) denetim ekranında
  // görünüyordu ama ZİL ÇALMIYORDU. Kalıcı olarak ölü bir görev tam da
  // bildirim gerektiren şeydir: kullanıcı denetim ekranını açmayı akıl
  // etmedikçe iş ilerlememesini fark edemezdi.
  describe('kayıt bulguları', () => {
    const finding = (over: Record<string, unknown> = {}) => ({
      ruleId: 'REC-004', taskId: 't1',
      summary: '"Renk yardımcısı" görevi plansız kuyrukta: atanamaz ve hiç çalışmaz.',
      severity: 'high', ...over,
    });

    it('yuksek onemli bulguyu kritik bildirim yapar', () => {
      const out = deriveNotifications({ recordFindings: [finding()] as never });
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ tone: 'critical', kind: 'record' });
      expect(out[0]!.detail).toContain('Renk yardımcısı');
    });

    it('orta onemli bulguyu uyari yapar', () => {
      const out = deriveNotifications({
        recordFindings: [finding({ ruleId: 'REC-002', severity: 'medium' })] as never,
      });
      expect(out[0]).toMatchObject({ tone: 'warning' });
    });

    // Aynı görev + kural için TEK bildirim: her taramada yeniden üretilen
    // bulgular zili boğardı.
    it('ayni bulgu icin tek kimlik uretir', () => {
      const out = deriveNotifications({
        recordFindings: [finding(), finding()] as never,
      });
      expect(new Set(out.map((n) => n.id)).size).toBe(1);
    });

    it('bulgu yoksa bildirim uretmez', () => {
      expect(deriveNotifications({ recordFindings: [] })).toEqual([]);
    });
  });
});
