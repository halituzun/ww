import { Inject, OnModuleDestroy } from '@nestjs/common';
import { SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import {
  EMPTY_EVENT_CURSOR, EntityIdSchema, decodeEventCursor, encodeEventCursor, type WsEnvelope,
} from '@ww/shared';

/** Bir turda gönderilen azami olay; panel de bu ölçekte bir pencere tutar. */
const WINDOW = 200;

/** Görevle ilgisi olmayan olaylar NIL taşır; panele boş dize gider. */
const NIL_TASK = '00000000-0000-0000-0000-000000000000';
import { listEvents, listRecentEvents, type ClickHouseClient } from '@ww/db';
import type { Server, WebSocket } from 'ws';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';


interface Subscription { readonly projectId: string; readonly afterCursor: string; }
interface ClientState { subscription?: Subscription; timer?: ReturnType<typeof setInterval>; }

/** Project-scoped, replayable event gateway. Redis remains a wakeup hint; the
 * bounded poll makes reconnects and missed notifications converge. */
@WebSocketGateway({ path: '/events' })
export class EventsGateway implements OnModuleDestroy {
  @WebSocketServer() server!: Server;
  readonly #clients = new Map<WebSocket, ClientState>();
  readonly #ch: ClickHouseClient;

  constructor(@Inject(SERVER_DATABASE) database: ServerDatabase) {
    this.#ch = database.ch;
  }

  handleConnection(client: WebSocket): void {
    this.#clients.set(client, {});
    client.on('close', () => this.remove(client));
    client.on('error', () => this.remove(client));
  }

  handleDisconnect(client: WebSocket): void { this.remove(client); }

  @SubscribeMessage('subscribe')
  async subscribe(client: WebSocket, payload: unknown): Promise<void> {
    const value = payload === null || typeof payload !== 'object' ? {} : payload as Record<string, unknown>;
    let projectId: string;
    let rawAfter: string;
    try {
      projectId = EntityIdSchema.parse(value['projectId']);
      // İstemci imleci OPAKTIR; sunucu onu yalnız doğrular ve geri verir.
      rawAfter = value['afterCursor'] === undefined
        ? EMPTY_EVENT_CURSOR
        : String(value['afterCursor']);
      decodeEventCursor(rawAfter);
    } catch (reason) {
      // RET SESSİZ KALMAZ. Doğrulama istisnası burada yutulunca istemciye
      // hiçbir şey dönmüyordu: panel soketi açık gördüğü için "Canlı" yazıyor
      // ama tek bir olay bile gelmiyordu — "bağlı görünüp donan panel".
      // Yoklama zamanlayıcısı da KURULMAZ: aboneliği olmayan istemci için
      // saniyede bir ClickHouse sorgusu sessiz bir yüktür.
      this.reject(client, reason);
      return;
    }
    const current = this.#clients.get(client);
    if (current === undefined) return;
    if (current.timer !== undefined) clearInterval(current.timer);
    const state: ClientState = { subscription: { projectId, afterCursor: rawAfter } };
    this.#clients.set(client, state);
    await this.publish(client, state);
    state.timer = setInterval(() => { void this.publish(client, state); }, 1_000);
  }

  /** Aboneliği reddeder ve SEBEBİNİ istemciye söyler. */
  private reject(client: WebSocket, reason: unknown): void {
    if (client.readyState !== client.OPEN) return;
    const envelope: WsEnvelope = {
      event: 'subscribe.rejected',
      projectId: '',
      taskId: '',
      cursor: EMPTY_EVENT_CURSOR,
      ts: new Date().toISOString(),
      data: { reason: reason instanceof Error ? reason.message : String(reason) },
    };
    client.send(JSON.stringify(envelope));
  }

  onModuleDestroy(): void {
    for (const client of this.#clients.keys()) this.remove(client);
  }

  private remove(client: WebSocket): void {
    const state = this.#clients.get(client);
    if (state?.timer !== undefined) clearInterval(state.timer);
    this.#clients.delete(client);
  }

  private async publish(client: WebSocket, state: ClientState): Promise<void> {
    const subscription = state.subscription;
    if (subscription === undefined || client.readyState !== client.OPEN) return;
    // İmleç sorguya verilir. Aksi halde en ESKİ 200 olay gelir ve proje 200
    // olayı geçtiğinde akış kalıcı olarak susardı (panel bağlı görünüp donardı).
    const after = subscription.afterCursor;
    // İMLEÇSİZ ABONELİK EN YENİDEN BAŞLAR. `listEvents` en ESKİ 200 olayı
    // döndürüyordu ve panel her açılışta sıfır imleçle bağlanıyor: 4511
    // olaylı bir projede canlı veriye ulaşmak saniyede 200 olayla ~23 saniye
    // sürüyor, kullanıcı o süre boyunca ESKİ olayların akışını izliyordu.
    // docs/08 istemcinin "snapshot high-water"dan başlamasını söyler.
    //
    // İmleç VARSA kaldığı yerden devam edilir: yeniden bağlanan panel
    // kaçırdıklarını almalı, en yeniye atlamamalıdır.
    const events = after === EMPTY_EVENT_CURSOR
      ? await listRecentEvents(this.#ch, subscription.projectId, WINDOW)
      : await listEvents(this.#ch, subscription.projectId, {
          limit: WINDOW, afterCursor: after,
        });
    for (const event of events) {
      const cursor = encodeEventCursor(event.created_at, event.event_id);
      if (cursor <= after) continue;
      const envelope: WsEnvelope = { event: event.event_type, projectId: subscription.projectId, taskId: event.task_id === NIL_TASK ? '' : event.task_id, cursor, ts: event.created_at, data: event.payload };
      client.send(JSON.stringify(envelope));
      state.subscription = { ...subscription, afterCursor: cursor };
    }
  }
}
