import { Inject, OnModuleDestroy } from '@nestjs/common';
import { SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { EntityIdSchema, type WsEnvelope } from '@ww/shared';
import { listEvents, type ClickHouseClient } from '@ww/db';
import type { Server, WebSocket } from 'ws';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';

interface Subscription { readonly projectId: string; readonly afterSeq: bigint; }
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
    const projectId = EntityIdSchema.parse(value['projectId']);
    const rawAfter = value['afterSeq'] === undefined ? '0' : String(value['afterSeq']);
    if (!/^\d+$/.test(rawAfter)) throw new Error('afterSeq gecersiz');
    const current = this.#clients.get(client);
    if (current === undefined) return;
    if (current.timer !== undefined) clearInterval(current.timer);
    const state: ClientState = { subscription: { projectId, afterSeq: BigInt(rawAfter) } };
    this.#clients.set(client, state);
    await this.publish(client, state);
    state.timer = setInterval(() => { void this.publish(client, state); }, 1_000);
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
    const events = await listEvents(this.#ch, subscription.projectId, { limit: 200 });
    const after = subscription.afterSeq;
    for (const event of events) {
      const seq = BigInt(event.seq);
      if (seq <= after) continue;
      const envelope: WsEnvelope = { event: event.event_type, projectId: subscription.projectId, seq: Number(seq <= BigInt(Number.MAX_SAFE_INTEGER) ? seq : BigInt(Number.MAX_SAFE_INTEGER)), ts: event.created_at, data: event.payload };
      client.send(JSON.stringify(envelope));
      state.subscription = { ...subscription, afterSeq: seq };
    }
  }
}
