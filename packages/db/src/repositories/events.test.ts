import { encodeEventCursor } from '@ww/shared';
import { randomUUID } from 'node:crypto';
import { NIL_UUID } from '@ww/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCh, type ClickHouseClient } from '../client.js';
import { runMigrations } from '../migrate.js';
import { clickhouseUp } from '../testutil.js';
import {
  appendEvent, getEvent, listEvents, listRecentEvents, type EventRow,
} from './events.js';
import { RepositoryConflictError } from './types.js';

const up = await clickhouseUp();
describe.skipIf(!up)('events repository', () => {
  const db = `ww_test_events_${Date.now()}_${process.pid}`;
  let ch: ClickHouseClient;
  beforeAll(async () => { await runMigrations({ database: db }); ch = createCh({ database: db }); });
  afterAll(async () => {
    const admin = createCh({ database: 'default' });
    await admin.command({ query: `DROP DATABASE IF EXISTS ${db}` });
    await admin.close(); await ch.close();
  });
  const event = (): EventRow => ({
    event_id: randomUUID(), seq: '1', project_id: randomUUID(), task_id: NIL_UUID,
    agent_id: NIL_UUID, event_type: 'status_change', tool_name: '',
    payload: { from: 'queued', to: 'assigned' }, duration_ms: 0,
    created_at: new Date().toISOString(),
  });

  it('append/get yapar ve fiziksel retry kopyasini listede katlar', async () => {
    const row = await appendEvent(ch, event());
    await ch.insert({ table: 'events', values: [{ ...row, payload: JSON.stringify(row.payload) }], format: 'JSONEachRow' });
    expect(await getEvent(ch, row.event_id)).toEqual(row);
    expect(await listEvents(ch, row.project_id)).toEqual([row]);
  });

  it('ayni event kimligindeki divergent duplicate kaydi fail-closed reddeder', async () => {
    const row = await appendEvent(ch, event());
    await ch.insert({
      table: 'events', values: [{ ...row, payload: '{"different":true}' }], format: 'JSONEachRow',
    });
    await expect(listEvents(ch, row.project_id)).rejects.toBeInstanceOf(RepositoryConflictError);
  });

  it('fiziksel retry kopyalari mantiksal liste limitini tuketmez', async () => {
    const projectId = randomUUID();
    const first = {
      ...event(),
      project_id: projectId,
      seq: '1',
      created_at: '2090-01-01T00:00:00.000Z',
    };
    const second = {
      ...event(),
      project_id: projectId,
      seq: '2',
      created_at: '2090-01-01T00:00:01.000Z',
    };
    const storedFirst = await appendEvent(ch, first);
    const storedSecond = await appendEvent(ch, second);
    await ch.insert({
      table: 'events',
      values: [{ ...storedFirst, payload: JSON.stringify(storedFirst.payload) }],
      format: 'JSONEachRow',
    });

    expect((await listEvents(ch, projectId, { limit: 2 })).map((row) => row.event_id))
      .toEqual([storedFirst.event_id, storedSecond.event_id]);
  });
});

describe.skipIf(!up)('listEvents imleç desteği', () => {
  const cursorDb = `ww_test_events_cursor_${Date.now()}`;
  let cursorCh: ClickHouseClient;

  beforeAll(async () => {
    await runMigrations({ database: cursorDb });
    cursorCh = createCh({ database: cursorDb });
  });
  afterAll(async () => {
    const admin = createCh({ database: 'default' });
    await admin.command({ query: `DROP DATABASE IF EXISTS ${cursorDb}` });
    await admin.close();
    await cursorCh.close();
  });

  const seed = async (projectId: string, count: number) => {
    await cursorCh.insert({
      table: 'events',
      values: Array.from({ length: count }, (_, i) => ({
        event_id: randomUUID(), seq: String(i + 1), project_id: projectId,
        task_id: NIL_UUID, agent_id: NIL_UUID, event_type: 'status_change',
        tool_name: '', payload: '{}', duration_ms: 0,
        created_at: new Date(Date.now() + i * 1000).toISOString(),
      })),
      format: 'JSONEachRow',
    });
  };

  // REGRESYON: listEvents en ESKİ N olayı döndürüyordu. Gateway bunları
  // imleçle süzdüğü için, bir proje N olayı geçtiğinde canlı besleme KALICI
  // olarak susuyordu: panel bağlı görünüp donuyordu.
  it('imleç verildiğinde yalnız sonraki olayları döndürür', async () => {
    const projectId = randomUUID();
    await seed(projectId, 12);
    const all = await listEvents(cursorCh, projectId, { limit: 20 });
    const cursor = encodeEventCursor(all[9]!.created_at, all[9]!.event_id);
    const after = await listEvents(cursorCh, projectId, { afterCursor: cursor, limit: 5 });
    expect(after).toHaveLength(2);
    expect(after.map((row) => row.event_id))
      .toEqual([all[10]!.event_id, all[11]!.event_id]);
  });

  it('imleç sınırdan büyük olsa bile yeni olayları bulur', async () => {
    const projectId = randomUUID();
    await seed(projectId, 8);
    const all = await listEvents(cursorCh, projectId, { limit: 20 });
    // Limit 3 iken imleç 5. sırada: eski davranışta ilk 3 gelir ve hepsi elenirdi.
    const cursor = encodeEventCursor(all[4]!.created_at, all[4]!.event_id);
    const page = await listEvents(cursorCh, projectId, { afterCursor: cursor, limit: 3 });
    expect(page.length).toBeGreaterThan(0);
    for (const row of page) {
      expect(encodeEventCursor(row.created_at, row.event_id) > cursor).toBe(true);
    }
  });

  // ASIL KUSUR: sıralama ZAMANA, süzme `seq`'e göreydi ve `seq` her yazıcıda
  // farklı ölçekte üretiliyordu (kilitler 0-3, çoğu olay epoch-ms, kurtarma ve
  // commit hash ~1e18). Tek bir büyük seq, imleci fırlatıp sonraki HER olayı
  // kalıcı olarak atlatıyordu.
  it('seq degerleri tutarsiz olsa bile hicbir olayi atlamaz', async () => {
    const projectId = randomUUID();
    const base = Date.now();
    await cursorCh.insert({
      table: 'events',
      values: [
        // Önce dev bir seq (kurtarma/commit yazıcılarının ürettiği gibi)
        { seq: '1152376219910902321', offset: 0 },
        // Sonra küçük seq'li olaylar: eski davranışta bunlar ASLA gelmezdi.
        { seq: '3', offset: 1 },
        { seq: '0', offset: 2 },
      ].map((row) => ({
        event_id: randomUUID(), seq: row.seq, project_id: projectId,
        task_id: NIL_UUID, agent_id: NIL_UUID, event_type: 'status_change',
        tool_name: '', payload: '{}', duration_ms: 0,
        created_at: new Date(base + row.offset * 1000).toISOString(),
      })),
      format: 'JSONEachRow',
    });

    const all = await listEvents(cursorCh, projectId, { limit: 10 });
    expect(all).toHaveLength(3);
    const cursor = encodeEventCursor(all[0]!.created_at, all[0]!.event_id);
    // Dev seq'li olaydan SONRA gelen küçük seq'li iki olay da teslim edilmeli.
    expect(await listEvents(cursorCh, projectId, { afterCursor: cursor, limit: 10 }))
      .toHaveLength(2);
  });

  it('imleç verilmezse eski davranış korunur', async () => {
    const projectId = randomUUID();
    await seed(projectId, 1);
    expect(await listEvents(cursorCh, projectId, { limit: 10 })).toHaveLength(1);
  });

  // ANLATICI KUSURU: `listEvents` imleçsiz çağrıldığında en ESKİ N olayı
  // döndürür (deponun kendi uyarısı). Narrator tam da böyle çağırıyordu ve
  // 4393 olaylı bir projede hep ilk 200 olayı anlatıyordu — yani sorulan işe
  // değil, projenin en eski geçmişine cevap veriyordu.
  it('listRecentEvents EN YENI olaylari kronolojik sirada doner', async () => {
    const projectId = randomUUID();
    await seed(projectId, 12);

    const recent = await listRecentEvents(cursorCh, projectId, 3);
    const all = await listEvents(cursorCh, projectId, { limit: 50 });

    expect(recent).toHaveLength(3);
    // Son üç olay olmalı...
    expect(recent.map((row) => row.event_id))
      .toEqual(all.slice(-3).map((row) => row.event_id));
    // ...ve anlatım için KRONOLOJİK sırada gelmeli (tersten değil).
    expect(recent[0]!.created_at <= recent[2]!.created_at).toBe(true);
  });

  it('listRecentEvents olay sayisi limitten azken hepsini doner', async () => {
    const projectId = randomUUID();
    await seed(projectId, 2);
    expect(await listRecentEvents(cursorCh, projectId, 10)).toHaveLength(2);
  });

  // ÇİFT KODLAMA KORUMASI. `payload` zaten JsonValue'dur ve depo onu
  // serileştirir; yazarken bir kez daha JSON.stringify yapmak yükü JSON
  // METNİNE çevirir ve `JSONExtract*` sorgularının hepsi SESSİZCE boş döner.
  // Canlı veride 69 error olayının 46'sı böyleydi: kayıt vardı, okunamıyordu.
  //
  // Sessiz kusuru yazma anında GÜRÜLTÜLÜ yapmak, onu bulunabilir kılar.
  describe('payload çift kodlama koruması', () => {
    const row = (payload: unknown) => ({
      event_id: randomUUID(), seq: '1', project_id: randomUUID(),
      task_id: NIL_UUID, agent_id: NIL_UUID, event_type: 'error' as const,
      tool_name: '', payload, duration_ms: 0,
      created_at: new Date().toISOString(),
    });

    it('JSON metni gecirilirse acik hata verir', async () => {
      await expect(appendEvent(cursorCh, row('{"reason":"x"}') as never))
        .rejects.toThrow(/çift kodla/i);
    });

    it('JSON dizisi metnini de reddeder', async () => {
      await expect(appendEvent(cursorCh, row('[1,2]') as never))
        .rejects.toThrow(/çift kodla/i);
    });

    // Düz metin yük MEŞRUDUR: her string yanlış değildir, yalnız JSON'a
    // benzeyen string yanlıştır.
    it('duz metin yuku kabul eder', async () => {
      await expect(appendEvent(cursorCh, row('sadece not') as never)).resolves.toBeTruthy();
    });

    it('nesne yuku kabul eder', async () => {
      await expect(appendEvent(cursorCh, row({ reason: 'x' }) as never)).resolves.toBeTruthy();
    });
  });
});
