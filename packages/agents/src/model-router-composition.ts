import type { ClickHouseClient, WwRedis } from '@ww/db';
import type { LlmProvider, ModelRouter, RouterOptions, UsageSink } from '@ww/providers';
import { ModelRouter as Router } from '@ww/providers';
import { EffectRunner, type EffectRunnerOptions } from './effect-runner.js';
import type { EffectEscalationPort } from './ports.js';
import { DurableProviderInvocationEffect, type ProviderEffectContext } from './provider-effect-adapter.js';

export interface DurableModelRouterOptions {
  readonly ch: ClickHouseClient;
  readonly redis: WwRedis;
  readonly usageSink: UsageSink;
  readonly fallbacks: RouterOptions['fallbacks'];
  readonly timeoutMs?: number;
  readonly effect?: Omit<EffectRunnerOptions, 'escalationPort'>;
  readonly escalationPort: EffectEscalationPort;
  readonly providerContext: ProviderEffectContext;
}

/** Phase 7 production composition boundary. Phase 8 supplies this to its
 * agent runtime; completion calls cannot bypass the durable effect runner. */
export function createDurableModelRouter(
  providers: Map<string, LlmProvider>,
  options: DurableModelRouterOptions,
): { router: ModelRouter; effectRunner: EffectRunner } {
  const effectRunner = new EffectRunner(options.ch, options.redis, {
    ...options.effect,
    escalationPort: options.escalationPort,
  });
  const invocationEffect = new DurableProviderInvocationEffect(
    effectRunner,
    options.providerContext,
  );
  const router = new Router(providers, {
    fallbacks: options.fallbacks,
    usageSink: options.usageSink,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    invocationEffect,
  });
  return { router, effectRunner };
}
