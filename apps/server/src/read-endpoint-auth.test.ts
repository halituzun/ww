import { describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { FilesController } from './files.controller.js';
import { MessagesController } from './messages.controller.js';
import { PlansController } from './plans.controller.js';
import { TasksController } from './tasks.controller.js';

/**
 * OKUMA UÇLARI DA OTURUM İSTER.
 *
 * NEDEN VAR: sekiz okuma ucu `parseLocalSession` çağırmıyordu — plan
 * gövdeleri (konsey dökümü dahil), görevler, dosya fihristi, proje haritası,
 * agent↔kullanıcı yazışmaları ve en ciddisi `files/content` (proje
 * workspace'inden DOSYA İÇERİĞİ) token'sız okunabiliyordu. Aynı dosyalardaki
 * YAZMA uçları zaten doğruluyordu; yani eksiklik bilinçli bir karar değil,
 * atlamaydı.
 */
const anonymous = { headers: {} } as never;
const database = { ch: {} } as never;

const cases: ReadonlyArray<readonly [string, () => unknown]> = [
  ['GET /plans', () => new PlansController({ list: async () => [] } as never).list(anonymous, 'p1')],
  ['GET /tasks', () => new TasksController({ list: async () => [] } as never).list(anonymous, 'p1')],
  ['GET /tasks/:taskId', () => new TasksController({ get: async () => null } as never).get(anonymous, 'p1', 't1')],
  ['GET /files', () => new FilesController(database).list(anonymous, 'p1')],
  ['GET /files/map', () => new FilesController(database).map(anonymous, 'p1')],
  ['GET /files/content', () => new FilesController(database).content(anonymous, 'p1', 'src/a.ts')],
  ['GET /messages', () => new MessagesController({} as never, database).list(anonymous, 'p1')],
  ['GET /messages/pending', () => new MessagesController({} as never, database).pending(anonymous, 'p1')],
  ['GET /messages/:messageId', () => new MessagesController({ get: async () => null } as never, database).get(anonymous, 'p1', 'm1')],
];

describe('okuma uçları oturum ister', () => {
  for (const [name, call] of cases) {
    it(`${name} token'sız reddeder`, async () => {
      await expect(Promise.resolve().then(call)).rejects.toBeInstanceOf(UnauthorizedException);
    });
  }
});
