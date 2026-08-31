import { canonicalSha256V1, type EntityId } from "@ww/shared";

export type CouncilTurnKind =
  | "proposal"
  | "objection"
  | "draft_synthesis"
  | "red_team"
  | "final_synthesis"
  | "research"
  | "debate_round"
  | "uncoordinated_report";

export interface CouncilMember {
  readonly agentId: EntityId;
  readonly modelRef: string;
  readonly role?: string;
}

export interface CouncilTurn {
  readonly memberId: EntityId;
  readonly kind: CouncilTurnKind;
  readonly turnNumber: number;
  readonly turnTitle: string;
  readonly text: string;
  readonly evidenceRefs: readonly string[];
  readonly dissenting?: boolean | undefined;
}

export interface CouncilTransport {
  send(turn: CouncilTurn & { sessionId: EntityId; recipient: EntityId }): Promise<{ messageId: string }>;
}

export interface CouncilInput {
  readonly sessionId: EntityId;
  readonly members: readonly CouncilMember[];
  readonly prompt: string;
  readonly maxTurns?: number | undefined;
  readonly maxCycles?: number | undefined;
  readonly focusedTopic?: string | undefined;
}

export interface ParsedDecisionItem {
  readonly topic: string;
  readonly decision: "accepted" | "rejected" | "modified";
  readonly rationale: string;
  readonly dissent: string;
  readonly turnNumber: number;
}

export interface ConvergenceCheckResult {
  readonly converged: boolean;
  readonly needsResearch: boolean;
  readonly researchQuery?: string | undefined;
  readonly openObjectionCount: number;
  readonly unresolvedCount: number;
  readonly contradictionCount: number;
  readonly reasons: readonly string[];
  readonly logLine?: string | undefined;
}

export interface CouncilResult {
  readonly sessionId: EntityId;
  readonly proposals: readonly CouncilTurn[];
  readonly objections: readonly CouncilTurn[];
  readonly draftSynthesis?: CouncilTurn | undefined;
  readonly redTeam?: CouncilTurn | undefined;
  readonly finalSynthesis: CouncilTurn;
  readonly synthesis: CouncilTurn; // backward compatibility
  readonly allTurns: readonly CouncilTurn[];
  readonly sessionHash: string;
  readonly converged: boolean;
  readonly status: "converged" | "uncoordinated";
  readonly totalTurns: number;
  readonly totalRounds: number;
  readonly decisions: readonly ParsedDecisionItem[];
  readonly convergenceLog: readonly ConvergenceCheckResult[];
}

/**
 * Bir üye iki denemede de boş dönerse turu bu metinle kaydederiz: konsey
 * susan üyeyi yutmaz, ama tek üyenin sessizliği de tüm oturumu düşürmez.
 */
export const NON_PARTICIPATION_TEXT =
  "[KATILMADI] Bu üye bu turda geçerli cevap üretmedi; konsensüs hesabına katılmadı.";

export class CouncilProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CouncilProtocolError";
  }
}

function toStrictTurn(t: CouncilTurn) {
  return {
    memberId: String(t.memberId),
    kind: String(t.kind),
    turnNumber: Number(t.turnNumber),
    turnTitle: String(t.turnTitle),
    text: String(t.text),
    evidenceRefs: [...t.evidenceRefs],
    dissenting: Boolean(t.dissenting),
  };
}

function trLower(text: string): string {
  return text.toLocaleLowerCase("tr-TR");
}

/**
 * H1 & H2 — Müzakere Yakınsama ve Araştırma İhtiyacı Ölçümü (Faz H)
 *
 * Tüm turları (allTurns) tarayarak gerçek yakınsama sayaçlarını hesaplar.
 * Her çağrıda [H1] log satırı üretir.
 */
export function checkConvergence(
  allTurns: readonly CouncilTurn[],
  currentTurnNum: number,
  projectPrompt: string = "",
): ConvergenceCheckResult & { readonly logLine: string } {
  const reasons: string[] = [];
  let unresolvedCount = 0;
  let contradictionCount = 0;
  let needsResearch = false;
  let researchQuery: string | undefined = undefined;

  // H2 — Bilgi eksikliği / araştırma turu: TÜM turları tara (proposal + objection dahil)
  const researchKeywords = [
    "bilgi eksikliği", "araştırılmalı", "araştırılacak",
    "destekleyip desteklemediği bilinmiyor", "kütüphane desteği belirsiz",
    "kod tabanı incelenmeli", "dış kaynak doğrulaması gerekli",
    "belirsiz", "araştırma gerekiyor", "kesin bilgi yok",
  ];
  for (const turn of allTurns) {
    if (turn.kind === 'proposal' || turn.kind === 'objection' || turn.kind === 'red_team') {
      const lower = trLower(turn.text);
      if (researchKeywords.some(kw => lower.includes(kw))) {
        needsResearch = true;
        researchQuery = "Mimari uyumluluk ve bağımlılık fizibilitesi araştırması";
        reasons.push(`Tur ${turn.turnNumber} (${turn.kind}): Teknik bilgi eksikliği tespit edildi`);
        break; // Bir araştırma turu yeterli
      }
    }
  }

  // Araştırma turu zaten yapıldıysa needsResearch'i sıfırla
  const hasResearchTurn = allTurns.some(t => t.kind === 'research');
  if (hasResearchTurn) {
    needsResearch = false;
    researchQuery = undefined;
    // GİZLİ HATA KORUMASI: findIndex -1 dönerse splice(-1, 1) dizinin SON
    // elemanını siler. Bugün zararsız (reasons bu noktada en çok bir eleman
    // taşıyor), ama bu satırdan önce başka bir push eklendiği an sessizce
    // YANLIŞ gerekçeyi silerdi.
    const researchReasonIndex = reasons.findIndex((r) => r.includes('bilgi eksikliği'));
    if (researchReasonIndex !== -1) reasons.splice(researchReasonIndex, 1);
  }

  // H1 — Çelişki sayacı: final_synthesis turlarına bak
  const finalTurns = allTurns.filter(t => t.kind === 'final_synthesis');
  const latestFinal = finalTurns[finalTurns.length - 1];
  const promptLower = trLower(projectPrompt);
  const promptHasOfflineLiveConflict =
    /(çevrimdışı|cevrimdisi|offline)/i.test(promptLower)
    && /(canlı|canli|live|anlık|anlik|çok oyunculu|cok oyunculu|skor tablosu)/i.test(promptLower);

  if (!latestFinal) {
    unresolvedCount += 1;
    reasons.push("Nihai sentez henüz üretilmedi");
  } else {
    const lower = trLower(latestFinal.text);

    // Başarısız sentez işareti
    if (lower.includes('[sentezleme_basarisiz]') || lower.includes('[sentezleme_ba\u015farisiz]')) {
      unresolvedCount += 1;
      reasons.push("Model sentez üretemedi, ek tur gerekiyor");
    }

    // Çözülmemiş çelişki
    const contradictionKeywords = ["uzlaşılamadı", "uzlaşilamadi", "uzlasilamadi", "çözülemedi", "çözülmedi", "aynı anda sağlanamaz",
      "ayni anda saglanamaz", "çelişki giderilemedi", "uzlaşmazlık devam ediyor"];
    const resolvedKeywords = ["çelişki çözüldü", "uzlaşmaya varıldı", "uzlaşıldı"];
    const hasContradiction = contradictionKeywords.some(kw => lower.includes(kw));
    const isResolved = resolvedKeywords.some(kw => lower.includes(kw));

    if (hasContradiction) {
      contradictionCount += 1;
      reasons.push(isResolved ? "Nihai tur çelişkiyi çözdüğünü söylüyor; çözüm açıkça doğrulanmalı" : "Nihai turda çözülmemiş çelişki tespit edildi");
      unresolvedCount += 1;
    }

    if (promptHasOfflineLiveConflict) {
      const mentionsOffline = /(çevrimdışı|cevrimdisi|offline)/i.test(lower);
      const mentionsLive = /(canlı|canli|live|anlık|anlik|çok oyunculu|cok oyunculu|skor tablosu)/i.test(lower);
      const hasExplicitResolution =
        /(yerel kuyruk|sonradan eşitle|sonradan esitle|opsiyon|seçenek|secenek|uzlaşılamadı|uzlasilamadi|kullanıcıya sunulacak)/i.test(lower);
      if (!mentionsOffline || !mentionsLive || !hasExplicitResolution) {
        contradictionCount += 1;
        unresolvedCount += 1;
        reasons.push("Brief'teki çevrimdışı çalışma ile canlı skor tablosu çelişkisi açıkça karara bağlanmadı");
      }
    }

    // Açık itiraz kaldı mı
    if (lower.includes("açık itiraz:") || lower.includes("karara bağlanmamış:")) {
      unresolvedCount += 1;
      reasons.push("Açık itirazlar henüz karara bağlanmadı");
    }
  }

  // H1 — İtiraz sayacı: objection/red_team turlarından KARAR: KABUL/RED ile eşleşmeyenleri bul
  const objectionTexts = allTurns
    .filter(t => t.kind === 'objection' || t.kind === 'red_team')
    .map(t => trLower(t.text));
  const resolvedInFinal = latestFinal ? trLower(latestFinal.text) : '';
  let openObjections = 0;
  for (const objText of objectionTexts) {
    // Basit heuristik: itiraz metninde geçen kritik kelime final sentezde ele alınmış mı
    const keywords = objText.match(/\b(çelişki|uzlaşmazlık|risk|zafiyet|sorun|eksik|hata|güvenlik|uyumsuz)\b/gi) ?? [];
    const uniqueKeywords = [...new Set(keywords.map(k => k.toLowerCase()))];
    const addressed = uniqueKeywords.some(kw => resolvedInFinal.includes(kw));
    if (!addressed && uniqueKeywords.length > 0) {
      openObjections += 1;
    }
  }
  if (openObjections > 0) {
    unresolvedCount += openObjections;
    reasons.push(`${openObjections} itiraz/red_team bulgusu nihai turda ele alınmamış`);
  }

  const converged = unresolvedCount === 0 && contradictionCount === 0 && !needsResearch;
  const logLine = `[H1] tur=${currentTurnNum} açık_itiraz=${openObjections} çözümsüz=${unresolvedCount} çelişki=${contradictionCount} araştırma=${needsResearch} → ${converged ? 'KAPANDI' : 'DEVAM'}`;

  return {
    converged,
    needsResearch,
    researchQuery,
    openObjectionCount: openObjections,
    unresolvedCount,
    contradictionCount,
    reasons,
    logLine,
  };
}

/**
 * H3 — Karar Defteri Ayrıştırıcı (Faz H3)
 */
export function extractDecisionsFromText(text: string, turnNumber: number): ParsedDecisionItem[] {
  const items: ParsedDecisionItem[] = [];
  const lines = text.split(/\r?\n/);
  let currentTopic = "";
  let currentDecision: "accepted" | "rejected" | "modified" = "accepted";
  let currentRationale = "";
  let currentDissent = "";

  const commitCurrent = () => {
    if (currentTopic.trim()) {
      items.push({
        topic: currentTopic.trim(),
        decision: currentDecision,
        rationale: currentRationale.trim() || "Konsey uzlaşmasıyla kabul edildi.",
        dissent: currentDissent.trim(),
        turnNumber,
      });
    }
    currentTopic = "";
    currentDecision = "accepted";
    currentRationale = "";
    currentDissent = "";
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const normalized = trLower(trimmed);

    const topicMatch = /^(?:bulgu\s*\d*|konu|madde)\s*:\s*(.+)$/iu.exec(trimmed)
      ?? /^\d+\.\s*(.+)$/u.exec(trimmed);
    if (topicMatch) {
      commitCurrent();
      currentTopic = topicMatch[1]?.trim() ?? "";
    } else if (normalized.startsWith("karar:") || /^karar\s*:/u.test(normalized)) {
      const decStr = trimmed.replace(/^karar\s*:/iu, "").trim().toLocaleUpperCase("tr-TR");
      if (decStr.includes("RED") || decStr.includes("UZLAŞILAMADI")) currentDecision = "rejected";
      else if (decStr.includes("REVİZE") || decStr.includes("MODİFİYE") || decStr.includes("KISMI")) currentDecision = "modified";
      else currentDecision = "accepted";
    } else if (/^(gerekçe|gerekce|plana yansıması|plana yansimasi)\s*:/iu.test(trimmed)) {
      currentRationale += (currentRationale ? " " : "") + trimmed.replace(/^(gerekçe|gerekce|plana yansıması|plana yansimasi)\s*:\s*/iu, "").trim();
    } else if (/^(şerh|serh|karşı oy|karsi oy)\s*:/iu.test(trimmed)) {
      currentDissent += (currentDissent ? " " : "") + trimmed.replace(/^(şerh|serh|karşı oy|karsi oy)\s*:\s*/iu, "").trim();
    } else if (currentTopic && !currentRationale) {
      currentRationale += (currentRationale ? " " : "") + trimmed;
    }
  }

  commitCurrent();
  return items;
}

export class CouncilService {
  readonly #transport: CouncilTransport;

  constructor(transport: CouncilTransport) {
    this.#transport = transport;
  }

  async run(
    input: CouncilInput,
    generate: (turn: Readonly<{
      kind: CouncilTurnKind;
      turnNumber: number;
      turnTitle: string;
      member: CouncilMember;
      prompt: string;
      prior: readonly CouncilTurn[];
    }>) => Promise<{ text: string; evidenceRefs?: readonly string[]; dissenting?: boolean }>,
  ): Promise<CouncilResult> {
    if (input.members.length < 3 || input.members.length > 4) {
      throw new CouncilProtocolError("konsey 3-4 uye olmalidir");
    }

    // maxCycles: docs/03 "en çok 2 itiraz-sentez döngüsü" der. Alan
    // tanımlıydı ama HİÇ OKUNMUYORDU; döngü her koşuda 9 tura kadar
    // gidiyordu. Her döngü iki tur harcar (müzakere/araştırma + yeni sentez),
    // sabit beş tur da baştan koşulur.
    const maxTurns = input.maxTurns
      ?? (input.maxCycles === undefined ? 9 : 5 + input.maxCycles * 2);
    const allTurns: CouncilTurn[] = [];
    const convergenceLog: ConvergenceCheckResult[] = [];
    const chair = input.members[0]!;
    const redTeamMember = input.members[1] ?? chair;
    const researcherMember = input.members[2] ?? chair;

    const generateWithRetry = async (request: Readonly<{
      kind: CouncilTurnKind;
      turnNumber: number;
      turnTitle: string;
      member: CouncilMember;
      prompt: string;
      prior: readonly CouncilTurn[];
    }>): Promise<{ text: string; evidenceRefs?: readonly string[]; dissenting?: boolean }> => {
      const first = await generate(request);
      if (first.text.trim().length > 0) return first;
      const second = await generate(request);
      if (second.text.trim().length > 0) return second;
      return {
        text: NON_PARTICIPATION_TEXT,
        evidenceRefs: [],
        dissenting: true,
      };
    };

    const makeTurn = (
      member: CouncilMember,
      kind: CouncilTurnKind,
      turnNumber: number,
      turnTitle: string,
      generated: { text: string; evidenceRefs?: readonly string[]; dissenting?: boolean },
    ): CouncilTurn => Object.freeze({
      memberId: member.agentId,
      kind,
      turnNumber,
      turnTitle,
      text: generated.text.trim(),
      evidenceRefs: Object.freeze([...(generated.evidenceRefs ?? [])]),
      dissenting: Boolean(generated.dissenting),
    });

    // TUR 1: Bağımsız Öneriler
    const proposals: CouncilTurn[] = [];
    for (const member of input.members) {
      const generated = await generateWithRetry({
        kind: "proposal",
        turnNumber: 1,
        turnTitle: "Tur 1 · Bağımsız Öneriler",
        member,
        prompt: input.prompt,
        prior: allTurns,
      });
      const turn = makeTurn(member, "proposal", 1, "Tur 1 · Bağımsız Öneriler", generated);
      proposals.push(turn);
      allTurns.push(turn);
      await this.#transport.send({
        ...turn,
        sessionId: input.sessionId,
        recipient: member.agentId,
      });
    }

    // KATILIM TABANI: tek bir üyenin susması konseyi düşürmez ama HİÇBİR üye
    // konuşmadıysa ortada müzakere yoktur. Bunu yakalamazsak bozuk bir
    // sağlayıcı, tamamı [KATILMADI] olan turlardan "plan" üretirdi.
    if (proposals.every((turn) => turn.text.startsWith("[KATILMADI]"))) {
      throw new CouncilProtocolError(
        "konsey uyelerinin hicbiri oneri turunda cevap uretmedi",
      );
    }

    // TUR 2: Karşılıklı Eleştiriler
    const objections: CouncilTurn[] = [];
    for (const member of input.members) {
      const generated = await generateWithRetry({
        kind: "objection",
        turnNumber: 2,
        turnTitle: "Tur 2 · Karşılıklı Eleştiriler",
        member,
        prompt: input.prompt,
        prior: allTurns,
      });
      const turn = makeTurn(member, "objection", 2, "Tur 2 · Karşılıklı Eleştiriler", generated);
      objections.push(turn);
      allTurns.push(turn);
      await this.#transport.send({
        ...turn,
        sessionId: input.sessionId,
        recipient: member.agentId,
      });
    }

    // TUR 3: Revize Birleşik Taslak
    const draftGen = await generateWithRetry({
      kind: "draft_synthesis",
      turnNumber: 3,
      turnTitle: "Tur 3 · Birleşik Taslak",
      member: chair,
      prompt: input.prompt,
      prior: allTurns,
    });
    const draftSynthesis = makeTurn(chair, "draft_synthesis", 3, "Tur 3 · Birleşik Taslak", draftGen);
    allTurns.push(draftSynthesis);
    await this.#transport.send({
      ...draftSynthesis,
      sessionId: input.sessionId,
      recipient: chair.agentId,
    });

    // TUR 4: Kırmızı Takım Turu
    const redGen = await generateWithRetry({
      kind: "red_team",
      turnNumber: 4,
      turnTitle: "Tur 4 · Kırmızı Takım İncelemesi",
      member: redTeamMember,
      prompt: input.prompt,
      prior: allTurns,
    });
    const redTeam = makeTurn(redTeamMember, "red_team", 4, "Tur 4 · Kırmızı Takım İncelemesi", redGen);
    allTurns.push(redTeam);
    await this.#transport.send({
      ...redTeam,
      sessionId: input.sessionId,
      recipient: redTeamMember.agentId,
    });

    let currentTurnNum = 5;
    let convergence = checkConvergence(allTurns, 4, input.prompt);
    convergenceLog.push(convergence);
    console.log(convergence.logLine);

    if (convergence.needsResearch && currentTurnNum <= maxTurns) {
      const resGen = await generateWithRetry({
        kind: "research",
        turnNumber: currentTurnNum,
        turnTitle: "Tur 5 · Araştırma ve Kod İncelemesi",
        member: researcherMember,
        prompt: `${input.prompt}\nAraştırma Odak Noktası: ${convergence.researchQuery ?? "Teknik fizibilite ve bağımlılık analizi"}`,
        prior: allTurns,
      });
      const resTurn = makeTurn(researcherMember, "research", currentTurnNum, "Tur 5 · Araştırma ve Kod İncelemesi", resGen);
      allTurns.push(resTurn);
      await this.#transport.send({
        ...resTurn,
        sessionId: input.sessionId,
        recipient: researcherMember.agentId,
      });
      currentTurnNum += 1;
    }

    // İlk nihai plan araştırma gerekiyorsa Tur 6, gerekmiyorsa Tur 5 olur.
    const finalGen = await generateWithRetry({
      kind: "final_synthesis",
      turnNumber: currentTurnNum,
      turnTitle: `Tur ${currentTurnNum} · Nihai Plan ve Kararlar`,
      member: chair,
      prompt: input.prompt,
      prior: allTurns,
    });
    let finalSynthesis = makeTurn(chair, "final_synthesis", currentTurnNum, `Tur ${currentTurnNum} · Nihai Plan ve Kararlar`, finalGen);
    allTurns.push(finalSynthesis);
    await this.#transport.send({
      ...finalSynthesis,
      sessionId: input.sessionId,
      recipient: chair.agentId,
    });

    // H1 & H2 — Dinamik Tur Döngüsü (5 Tur Yetmezse Devam Et, En Çok 9)
    convergence = checkConvergence(allTurns, currentTurnNum, input.prompt);
    convergenceLog.push(convergence);
    console.log(convergence.logLine);

    while (!convergence.converged && currentTurnNum < maxTurns) {
      currentTurnNum += 1;

      if (convergence.needsResearch) {
        // H2. Araştırma Turu
        const resGen = await generateWithRetry({
          kind: "research",
          turnNumber: currentTurnNum,
          turnTitle: `Tur ${currentTurnNum} · Araştırma ve Kod İncelemesi`,
          member: researcherMember,
          prompt: `${input.prompt}\nAraştırma Odak Noktası: ${convergence.researchQuery ?? "Teknik fizibilite ve bağımlılık analizi"}`,
          prior: allTurns,
        });
        const resTurn = makeTurn(researcherMember, "research", currentTurnNum, `Tur ${currentTurnNum} · Araştırma ve Kod İncelemesi`, resGen);
        allTurns.push(resTurn);
        await this.#transport.send({
          ...resTurn,
          sessionId: input.sessionId,
          recipient: researcherMember.agentId,
        });
      } else {
        // H1. Ek Müzakere / Çelişki Çözümleme Turu
        const debGen = await generateWithRetry({
          kind: "debate_round",
          turnNumber: currentTurnNum,
          turnTitle: `Tur ${currentTurnNum} · Çelişki ve İtiraz Müzakeresi`,
          member: redTeamMember,
          prompt: `${input.prompt}\nÇözümlenecek İtirazlar/Çelişkiler:\n${convergence.reasons.join("\n")}`,
          prior: allTurns,
        });
        const debTurn = makeTurn(redTeamMember, "debate_round", currentTurnNum, `Tur ${currentTurnNum} · Çelişki ve İtiraz Müzakeresi`, debGen);
        allTurns.push(debTurn);
        await this.#transport.send({
          ...debTurn,
          sessionId: input.sessionId,
          recipient: redTeamMember.agentId,
        });
      }

      // Yeni sentez turu (eğer üst sınıra ulaşılmadıysa)
      if (currentTurnNum < maxTurns) {
        currentTurnNum += 1;
        const synthGen = await generateWithRetry({
          kind: "final_synthesis",
          turnNumber: currentTurnNum,
          turnTitle: `Tur ${currentTurnNum} · Güncellenmiş Nihai Karar`,
          member: chair,
          prompt: input.prompt,
          prior: allTurns,
        });
        finalSynthesis = makeTurn(chair, "final_synthesis", currentTurnNum, `Tur ${currentTurnNum} · Güncellenmiş Nihai Karar`, synthGen);
        allTurns.push(finalSynthesis);
        await this.#transport.send({
          ...finalSynthesis,
          sessionId: input.sessionId,
          recipient: chair.agentId,
        });
        convergence = checkConvergence(allTurns, currentTurnNum, input.prompt);
        convergenceLog.push(convergence);
        console.log(convergence.logLine);
      }
    }

    const isConverged = convergence.converged;
    const finalStatus: "converged" | "uncoordinated" = isConverged ? "converged" : "uncoordinated";

    // H3. Kararları çıkar
    const parsedDecisions = extractDecisionsFromText(finalSynthesis.text, finalSynthesis.turnNumber);

    const sessionHash = canonicalSha256V1({
      sessionId: input.sessionId,
      proposals: proposals.map(toStrictTurn),
      objections: objections.map(toStrictTurn),
      draftSynthesis: toStrictTurn(draftSynthesis),
      redTeam: toStrictTurn(redTeam),
      finalSynthesis: toStrictTurn(finalSynthesis),
      totalTurns: allTurns.length,
      status: finalStatus,
    });

    return Object.freeze({
      sessionId: input.sessionId,
      proposals: Object.freeze(proposals),
      objections: Object.freeze(objections),
      draftSynthesis,
      redTeam,
      finalSynthesis,
      synthesis: finalSynthesis, // backward compatibility
      allTurns: Object.freeze(allTurns),
      sessionHash,
      converged: isConverged,
      status: finalStatus,
      totalTurns: allTurns.length,
      totalRounds: currentTurnNum,
      decisions: Object.freeze(parsedDecisions),
      convergenceLog: Object.freeze(convergenceLog),
    });
  }
}
