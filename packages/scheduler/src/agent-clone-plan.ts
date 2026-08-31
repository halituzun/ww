// "Klon açmalı mıyım?" kararı (docs/03 → klonlama).
//
// NEDEN VAR: `AgentCloneService` yazılmış ve sınırlarıyla birlikte testliydi
// ama HİÇBİR üretim yolu onu çağırmıyordu. Sonuç: eşleşen tüm agent'lar
// meşgulken atama "idle worker bulunamadi" ile düşüyordu — canlı koşuda tam
// olarak buna takıldım. docs/03 bu durumu klonlamanın çözmesini söylüyor.
//
// Karar burada saf tutulur: klonlamak AGENT YARATIR, yani yanlış koşulda
// çağrılırsa kaynak israfıdır.

export interface CloneCandidate {
  readonly agent_id: string;
  readonly role: string;
  readonly group: string;
  readonly status: string;
  readonly prompt_name: string;
  readonly prompt_version: number;
}

export interface CloneNeed {
  readonly role: string;
  readonly group: string;
  /** Brief mühürlü prompt isterse klon da o prompt'u taşımalıdır. */
  readonly promptName?: string | undefined;
  readonly promptVersion?: number | undefined;
}

/**
 * Klonlanacak kaynak agent. `undefined` dönerse klonlama YAPILMAZ:
 * - uygun rol/grup/prompt taşıyan hiçbir agent yoksa klon da uymaz
 * - zaten boşta bir eşleşme varsa klona gerek yoktur
 */
export function pickCloneSource(
  agents: readonly CloneCandidate[],
  need: CloneNeed,
): CloneCandidate | undefined {
  const matches = agents.filter((agent) =>
    agent.role === need.role && agent.group === need.group &&
    agent.status !== 'stopped' &&
    (need.promptName === undefined || agent.prompt_name === need.promptName) &&
    (need.promptVersion === undefined || agent.prompt_version === need.promptVersion));

  if (matches.length === 0) return undefined;
  // Boşta eşleşme varsa klonlamak gereksiz agent yaratır.
  if (matches.some((agent) => agent.status === 'idle')) return undefined;
  // Kararlı seçim: aynı girdi hep aynı kaynağı klonlar.
  return [...matches].sort((left, right) => left.agent_id.localeCompare(right.agent_id))[0];
}
