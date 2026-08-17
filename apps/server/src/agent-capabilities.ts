// Agent'ların kendi adlarına mesaj gönderebilmesi için yetenek kimlikleri.
//
// NEDEN VAR: `PrincipalResolver` agent kimliğini bir kimlik-bilgisi → agent
// haritasına göre doğrular, ama bu harita üretimde HİÇ doldurulmuyordu.
// Sonuç: worker kendi adına mesaj gönderemiyor, iletişim 'system' kimliğine
// düşüyor ve politika onu reddediyordu ("routing matrisinde system gonderici
// rotasi yoktur") — çünkü system yalnızca kod-kaynaklı tırmandırma içindir.
import { randomUUID } from 'node:crypto';
import type { EntityId } from '@ww/shared';

export interface AgentRowLike {
  readonly agent_id: string;
  readonly role: string;
  readonly status: string;
}

export interface AgentCapabilityBindingLike {
  readonly projectId: EntityId;
  readonly agentId: EntityId;
}

export interface BuiltAgentCapabilities {
  /** PrincipalResolver'a verilir: kimlik bilgisi → agent bağlantısı. */
  readonly capabilities: ReadonlyMap<string, AgentCapabilityBindingLike>;
  credentialFor(agentId: EntityId): string | undefined;
}

export function buildAgentCapabilities(
  projectId: EntityId,
  agents: readonly AgentRowLike[],
): BuiltAgentCapabilities {
  const capabilities = new Map<string, AgentCapabilityBindingLike>();
  const byAgent = new Map<string, string>();

  for (const agent of agents) {
    // Durdurulmuş agent adına mesaj gönderilememeli.
    if (agent.status === 'stopped') continue;
    // Her agent'a AYRI kimlik bilgisi: paylaşılan bir sır, bir agent'ın
    // diğerinin yerine geçmesine izin verirdi.
    const credential = randomUUID();
    capabilities.set(credential, {
      projectId,
      agentId: agent.agent_id as EntityId,
    });
    byAgent.set(agent.agent_id, credential);
  }

  return {
    capabilities,
    credentialFor: (agentId) => byAgent.get(agentId),
  };
}
