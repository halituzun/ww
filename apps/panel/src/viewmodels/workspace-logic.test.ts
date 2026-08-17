import { describe, expect, it } from 'vitest';
import {
  appendTimelineEvent,
  countTaskStatuses,
  pickSelectedFile,
  TIMELINE_LIMIT,
} from './workspace-logic.js';
import type { FileIndex, Task } from '../services/projects.js';

const task = (status: string): Task =>
  ({ task_id: `t-${status}`, title: status, status, priority: 5, updated_at: '' });

const file = (path: string): FileIndex => ({
  file_path: path, summary: '', layer: 'other', exports: [],
  related_task_ids: [], last_commit_hash: '', change_count: 0, updated_at: '',
});

describe('countTaskStatuses', () => {
  it('durumları sayar', () => {
    expect(countTaskStatuses([task('queued'), task('queued'), task('done')]))
      .toEqual({ queued: 2, done: 1 });
  });

  it('boş listede boş sonuç döner', () => {
    expect(countTaskStatuses([])).toEqual({});
  });
});

describe('pickSelectedFile', () => {
  // Yenilemede seçimin kaymaması kullanıcı için kritik: dosyaya bakarken
  // liste güncellenince başka dosyaya atlamamalı.
  it('mevcut seçim listede duruyorsa korunur', () => {
    expect(pickSelectedFile('b.ts', [file('a.ts'), file('b.ts')])).toBe('b.ts');
  });

  it('mevcut seçim listeden düştüyse ilk dosyaya geçer', () => {
    expect(pickSelectedFile('silindi.ts', [file('a.ts')])).toBe('a.ts');
  });

  it('seçim yokken ilk dosyayı seçer', () => {
    expect(pickSelectedFile(undefined, [file('a.ts')])).toBe('a.ts');
  });

  it('liste boşsa seçim bırakmaz', () => {
    expect(pickSelectedFile('a.ts', [])).toBeUndefined();
  });
});

describe('appendTimelineEvent', () => {
  const event = (seq: number) => ({ event: 'task.updated', seq, ts: '', data: null });

  it('olayı sona ekler', () => {
    expect(appendTimelineEvent([event(1)], event(2)).map((e) => e.seq)).toEqual([1, 2]);
  });

  // Sınırsız birikim paneli zamanla kilitler.
  it('tamponu sınırda tutar ve en eskiyi düşürür', () => {
    const full = Array.from({ length: TIMELINE_LIMIT }, (_, i) => event(i));
    const next = appendTimelineEvent(full, event(9999));
    expect(next).toHaveLength(TIMELINE_LIMIT);
    expect(next.at(-1)?.seq).toBe(9999);
    expect(next[0]?.seq).toBe(1);
  });

  // WebSocket yeniden bağlanınca aynı olay tekrar gelebilir.
  it('aynı seq iki kez eklenmez', () => {
    const next = appendTimelineEvent([event(5)], event(5));
    expect(next).toHaveLength(1);
  });

  it('sıra dışı gelen olayı yine de kaydeder', () => {
    expect(appendTimelineEvent([event(5)], event(3)).map((e) => e.seq)).toEqual([5, 3]);
  });
});
