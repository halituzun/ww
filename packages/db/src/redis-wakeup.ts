import {
  EntityIdSchema,
  PartyRefV1Schema,
  type EntityId,
  type PartyRefV1,
} from '@ww/shared';
import type { WwRedis } from './redis.js';

export const COMMUNICATION_WAKEUP_CHANNEL = 'ww:communication:wakeup';
export const DEFAULT_WAKEUP_PUBLISH_TIMEOUT_MS = 1_000;
export const MAX_WAKEUP_PUBLISH_TIMEOUT_MS = 5_000;

export interface CommunicationWakeup {
  readonly messageId: EntityId;
  readonly recipient: PartyRefV1;
  readonly projectId: EntityId;
}

/** Narrow projection callers map from a successful canonical message write. */
export interface DurableCommunicationMessagePointer {
  readonly messageId: string;
  readonly projectId: string;
  readonly recipient: PartyRefV1;
}

/** Narrow projection callers map from a successful enqueued receipt write. */
export interface DurableCommunicationReceiptPointer {
  readonly messageId: string;
  readonly projectId: string;
  readonly recipientId: string;
  readonly recipient: PartyRefV1;
  readonly state: 'enqueued';
}

export interface DurableCommunicationWrite {
  readonly message: DurableCommunicationMessagePointer;
  readonly receipts: readonly DurableCommunicationReceiptPointer[];
}

export interface CommunicationWakeupPublishResult extends CommunicationWakeup {
  readonly published: boolean;
  readonly receiverCount: number;
}

export interface CommunicationWakeupPublisherOptions {
  onPublishError?: (
    error: Error,
    wakeup: CommunicationWakeup,
  ) => void | Promise<void>;
  publishTimeoutMs?: number;
  signal?: AbortSignal;
}

function defaultPublishError(error: Error): void {
  console.error(`[ww] Redis iletisim uyandirma hatasi: ${error.message}`);
}

function positiveBoundedTimeout(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_WAKEUP_PUBLISH_TIMEOUT_MS
  ) {
    throw new Error(
      `publishTimeoutMs 1-${MAX_WAKEUP_PUBLISH_TIMEOUT_MS} araliginda olmalidir`,
    );
  }
  return value;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function signalError(signal: AbortSignal, message: string): Error {
  return signal.reason instanceof Error ? signal.reason : abortError(message);
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted) throw signalError(signal, message);
}

function forceDestroy(client: WwRedis): void {
  try {
    client.destroy();
  } catch {
    // Disposable publish cleanup'i asil publish sonucunu golgelememeli.
  }
}

function idempotentDiscard(client: WwRedis): () => void {
  let destroyed = false;
  return () => {
    if (destroyed) return;
    destroyed = true;
    forceDestroy(client);
  };
}

function observePublishError(
  callback: (error: Error, wakeup: CommunicationWakeup) => void | Promise<void>,
  error: Error,
  wakeup: CommunicationWakeup,
): void {
  try {
    // Observer tamamlanmasi durable-first sonucu bloke etmez. Rejected Promise
    // hemen handle edilir; observer hatasi/payload'i sonuc veya loglara sizmaz.
    void Promise.resolve(callback(error, wakeup)).catch(() => undefined);
  } catch {
    // Senkron throw da wakeup sonucunu veya kalan pointerlari etkileyemez.
  }
}

function commandSignal(
  external: AbortSignal | undefined,
  timeoutMs: number,
): { readonly signal: AbortSignal; cleanup(): void } {
  const controller = new AbortController();
  const onExternalAbort = (): void => controller.abort(
    external?.reason instanceof Error
      ? external.reason
      : abortError('Redis iletisim wakeup publish iptal edildi'),
  );
  if (external?.aborted) onExternalAbort();
  else external?.addEventListener('abort', onExternalAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(
    new Error(`Redis iletisim wakeup publish ${timeoutMs} ms zaman asimina ugradi`),
  ), timeoutMs);
  timeout.unref();
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      external?.removeEventListener('abort', onExternalAbort);
    },
  };
}

function settleWithSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const observed = work.then(
    (value) => value,
    (error: unknown) => { throw error; },
  );
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signalError(signal, 'Redis komutu iptal edildi'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([observed, cancelled]).finally(() => {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  });
}

function wakeupsFromDurableWrite(
  input: DurableCommunicationWrite,
): readonly CommunicationWakeup[] {
  if (input.receipts.length === 0) {
    throw new Error('Iletisim wakeup icin en az bir kalici receipt gereklidir');
  }
  const messageId = EntityIdSchema.parse(input.message.messageId);
  const projectId = EntityIdSchema.parse(input.message.projectId);
  const declaredRecipient = PartyRefV1Schema.parse(input.message.recipient);
  const recipients = new Set<string>();
  const wakeups: CommunicationWakeup[] = [];
  for (const receipt of input.receipts) {
    const receiptMessageId = EntityIdSchema.parse(receipt.messageId);
    const receiptProjectId = EntityIdSchema.parse(receipt.projectId);
    const recipient = PartyRefV1Schema.parse(receipt.recipient);
    if (
      receiptMessageId !== messageId ||
      receiptProjectId !== projectId ||
      receipt.state !== 'enqueued'
    ) {
      throw new Error('Iletisim wakeup receipt kalici mesajla eslesmiyor');
    }
    if (receipt.recipientId !== recipient.id || recipient.type === 'broadcast') {
      throw new Error('Iletisim wakeup receipt recipient snapshotu gecersiz');
    }
    const recipientIdentity = `${recipient.type}:${recipient.id}`;
    if (recipients.has(recipientIdentity)) {
      throw new Error(`Iletisim wakeup recipient tekrari: ${recipient.id}`);
    }
    recipients.add(recipientIdentity);
    wakeups.push(Object.freeze({
      messageId,
      recipient,
      projectId,
    }));
  }
  if (
    declaredRecipient.type !== 'broadcast' &&
    (
      wakeups.length !== 1 ||
      wakeups[0]?.recipient.type !== declaredRecipient.type ||
      wakeups[0].recipient.id !== declaredRecipient.id
    )
  ) {
    throw new Error('Dogrudan mesaj wakeup recipient snapshotu zarfla eslesmiyor');
  }
  return Object.freeze(wakeups);
}

/**
 * Publishes pointer-only, best-effort wakeups after message + receipt repository
 * success. Redis payloads are never delivery proof; consumers must reload the
 * canonical inbox from ClickHouse using the three pointer fields.
 */
export class CommunicationWakeupPublisher {
  readonly #redis: WwRedis;
  readonly #onPublishError: (
    error: Error,
    wakeup: CommunicationWakeup,
  ) => void | Promise<void>;
  readonly #publishTimeoutMs: number;
  readonly #signal: AbortSignal | undefined;

  constructor(redis: WwRedis, options: CommunicationWakeupPublisherOptions = {}) {
    this.#redis = redis;
    this.#onPublishError = options.onPublishError ?? defaultPublishError;
    this.#publishTimeoutMs = positiveBoundedTimeout(
      options.publishTimeoutMs ?? DEFAULT_WAKEUP_PUBLISH_TIMEOUT_MS,
    );
    this.#signal = options.signal;
  }

  async publishAfterDurableWrite(
    input: DurableCommunicationWrite,
  ): Promise<readonly CommunicationWakeupPublishResult[]> {
    const wakeups = wakeupsFromDurableWrite(input);
    const results: CommunicationWakeupPublishResult[] = [];
    let client: WwRedis | undefined;
    let discard: (() => void) | undefined;
    let command: ReturnType<typeof commandSignal> | undefined;
    let onAbort: (() => void) | undefined;

    const failRemaining = (error: Error): void => {
      for (let index = results.length; index < wakeups.length; index += 1) {
        const wakeup = wakeups[index]!;
        observePublishError(this.#onPublishError, error, wakeup);
        results.push(Object.freeze({
          ...wakeup,
          published: false,
          receiverCount: 0,
        }));
      }
    };

    try {
      // Tek toplam deadline connect ve butun recipient publish'lerini kapsar.
      // Pre-abort duplicate/connect/PUBLISH dahil hicbir Redis isi baslatmaz.
      throwIfAborted(this.#signal, 'Redis iletisim wakeup publish iptal edildi');
      command = commandSignal(this.#signal, this.#publishTimeoutMs);
      throwIfAborted(command.signal, 'Redis iletisim wakeup publish iptal edildi');
      client = this.#redis.duplicate();
      discard = idempotentDiscard(client);
      client.on('error', () => undefined);
      onAbort = discard;
      command.signal.addEventListener('abort', onAbort, { once: true });
      throwIfAborted(command.signal, 'Redis iletisim wakeup publish iptal edildi');
      await settleWithSignal(client.connect(), command.signal);

      for (const wakeup of wakeups) {
        throwIfAborted(command.signal, 'Redis iletisim wakeup publish iptal edildi');
        const receiverCount = await settleWithSignal(
          client.withAbortSignal(command.signal).publish(
            COMMUNICATION_WAKEUP_CHANNEL,
            JSON.stringify(wakeup),
          ),
          command.signal,
        );
        if (!Number.isSafeInteger(receiverCount) || receiverCount < 0) {
          throw new Error('Redis publish receiver count gecersiz');
        }
        results.push(Object.freeze({ ...wakeup, published: true, receiverCount }));
      }
    } catch (error) {
      discard?.();
      failRemaining(error instanceof Error ? error : new Error('Redis publish basarisiz oldu'));
    } finally {
      if (onAbort !== undefined && command !== undefined) {
        command.signal.removeEventListener('abort', onAbort);
      }
      discard?.();
      command?.cleanup();
    }
    return Object.freeze(results);
  }
}
