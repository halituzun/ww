import { canonicalSha256V1, type EntityId } from '@ww/shared';

export interface CouncilMember { readonly agentId: EntityId; readonly modelRef: string; }
export interface CouncilTurn { readonly memberId: EntityId; readonly kind: 'proposal' | 'objection' | 'synthesis'; readonly text: string; readonly evidenceRefs: readonly string[]; }
export interface CouncilTransport { send(input: Readonly<{ sessionId: EntityId; recipient: EntityId; kind: 'proposal' | 'objection' | 'synthesis'; text: string; evidenceRefs: readonly string[] }>): Promise<{ messageId: EntityId }>; }
export interface CouncilInput { readonly sessionId: EntityId; readonly members: readonly CouncilMember[]; readonly prompt: string; readonly maxCycles?: number; }
export interface CouncilResult { readonly sessionId: EntityId; readonly proposals: readonly CouncilTurn[]; readonly objections: readonly CouncilTurn[]; readonly synthesis: CouncilTurn; readonly cycles: number; }

export class CouncilProtocolError extends Error {
  constructor(message: string) { super(message); this.name = 'CouncilProtocolError'; }
}

/** Deterministic, bounded council protocol. Model generation is injected; this
 * class owns round limits, recipient identity, and durable turn ordering. */
export class CouncilService {
  readonly #transport: CouncilTransport;
  constructor(transport: CouncilTransport) { this.#transport = transport; }

  async run(input: CouncilInput, generate: (turn: Readonly<{ kind: CouncilTurn['kind']; member: CouncilMember; prompt: string; prior: readonly CouncilTurn[] }>) => Promise<{ text: string; evidenceRefs?: readonly string[] }>): Promise<CouncilResult> {
    if (input.members.length < 3 || input.members.length > 4) throw new CouncilProtocolError('konsey 3-4 uye olmalidir');
    const cycles = input.maxCycles ?? 2;
    if (!Number.isSafeInteger(cycles) || cycles < 1 || cycles > 2) throw new CouncilProtocolError('konsey tur limiti 1-2 olmalidir');
    const proposals: CouncilTurn[] = [];
    for (const member of input.members) {
      const generated = await generate({ kind: 'proposal', member, prompt: input.prompt, prior: proposals });
      const turn = Object.freeze({ memberId: member.agentId, kind: 'proposal' as const, text: generated.text.trim(), evidenceRefs: Object.freeze([...(generated.evidenceRefs ?? [])]) });
      if (turn.text.length === 0) throw new CouncilProtocolError('bos proposal');
      proposals.push(turn);
      await this.#transport.send({ sessionId: input.sessionId, recipient: member.agentId, kind: 'proposal', text: turn.text, evidenceRefs: turn.evidenceRefs });
    }
    const objections: CouncilTurn[] = [];
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      for (const member of input.members) {
        const generated = await generate({ kind: 'objection', member, prompt: input.prompt, prior: [...proposals, ...objections] });
        const turn = Object.freeze({ memberId: member.agentId, kind: 'objection' as const, text: generated.text.trim(), evidenceRefs: Object.freeze([...(generated.evidenceRefs ?? [])]) });
        if (turn.text.length === 0) throw new CouncilProtocolError('bos objection');
        objections.push(turn);
        await this.#transport.send({ sessionId: input.sessionId, recipient: member.agentId, kind: 'objection', text: turn.text, evidenceRefs: turn.evidenceRefs });
      }
    }
    const chair = input.members[0]!;
    const generated = await generate({ kind: 'synthesis', member: chair, prompt: input.prompt, prior: [...proposals, ...objections] });
    const synthesis = Object.freeze({ memberId: chair.agentId, kind: 'synthesis' as const, text: generated.text.trim(), evidenceRefs: Object.freeze([...(generated.evidenceRefs ?? [])]) });
    if (synthesis.text.length === 0) throw new CouncilProtocolError('bos synthesis');
    await this.#transport.send({ sessionId: input.sessionId, recipient: chair.agentId, kind: 'synthesis', text: synthesis.text, evidenceRefs: synthesis.evidenceRefs });
    // Touch the stable hash in the result contract so callers can persist a
    // deterministic plan identity without trusting message arrival order.
    const sessionHash = canonicalSha256V1({ sessionId: input.sessionId, proposals, objections, synthesis });
    return Object.freeze({ sessionId: input.sessionId, proposals: Object.freeze(proposals), objections: Object.freeze(objections), synthesis, cycles, ...({ sessionHash } as { readonly sessionHash: string }) });
  }
}
