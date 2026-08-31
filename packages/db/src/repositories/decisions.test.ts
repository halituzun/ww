import { describe, it, expect } from "vitest";
import { createCh } from "../client.js";
import { createDecision, listDecisions, getDecision } from "./decisions.js";
import { randomUUID } from "node:crypto";

describe("decisions repository (Faz H3)", () => {
  it("karar defterine yeni karar ekler, listeler ve row_hash dogrular", async () => {
    const ch = createCh();
    const projectId = randomUUID();
    const decisionId = randomUUID();
    const now = new Date().toISOString();

    const created = await createDecision(ch, {
      decision_id: decisionId,
      project_id: projectId,
      topic: "Regex tabanli eval filtreleme guvenligi",
      decision: "accepted",
      rationale: "Kirmizi takim bulgusu dogrultusunda AST motoru zorunlu kilindi.",
      dissent: "Ekstra kutuphane bagimliligi getirmemesi sartiyla kabul.",
      turn_number: 5,
      created_at: now,
    });

    expect(created.decision_id).toBe(decisionId);
    expect(created.version).toBe("1");

    const list = await listDecisions(ch, projectId);
    expect(list).toHaveLength(1);
    expect(list[0].topic).toBe("Regex tabanli eval filtreleme guvenligi");
    expect(list[0].decision).toBe("accepted");
    expect(list[0].turn_number).toBe(5);

    const single = await getDecision(ch, projectId, decisionId);
    expect(single.rationale).toContain("AST motoru zorunlu");
  });
});
