import { Module, type DynamicModule } from '@nestjs/common';
import type { InboxWorker } from '@ww/agents';
import {
  INBOX_DRAIN_PORT,
  INBOX_POLL_OPTIONS,
  INBOX_WAKEUP_PORT,
  InboxPollService,
  type InboxDrainPort,
  type InboxPollOptions,
  type InboxWakeupPort,
} from './inbox-poll.service.js';

export interface InboxPollingModuleOptions {
  readonly drainPort: InboxDrainPort;
  readonly wakeupPort?: InboxWakeupPort;
  readonly poll?: InboxPollOptions;
}

/** Adapts the Phase 5 worker while preserving the server-owned cancellation boundary. */
export function inboxWorkerDrainPort(
  worker: Pick<InboxWorker, 'drainOnce'>,
): InboxDrainPort {
  const port: InboxDrainPort = {
    drainOnce: async (consumerId: string, context: { readonly signal: AbortSignal }) => {
      context.signal.throwIfAborted();
      await worker.drainOnce(consumerId, context.signal);
    },
  };
  return Object.freeze(port);
}

@Module({})
export class InboxPollingModule {
  static forRoot(options: InboxPollingModuleOptions): DynamicModule {
    return {
      module: InboxPollingModule,
      providers: [
        { provide: INBOX_DRAIN_PORT, useValue: options.drainPort },
        { provide: INBOX_WAKEUP_PORT, useValue: options.wakeupPort ?? null },
        { provide: INBOX_POLL_OPTIONS, useValue: options.poll ?? {} },
        InboxPollService,
      ],
      exports: [InboxPollService],
    };
  }
}
