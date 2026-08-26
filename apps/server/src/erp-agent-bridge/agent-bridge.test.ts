import { describe, expect, it } from "vitest";
import { AgentBridgeService } from "./agent-bridge.service.js";

describe("AgentBridgeService", () => {
  it("agent kaydini basariyla olusturur ve durumunu dondurur", () => {
    const service = new AgentBridgeService();
    const reg = service.registerAgent({
      pair_code: "XYZ123",
      db_type: "mssql",
      host: "192.168.1.50",
      port: 1433,
      database: "MIKRO_DB_2026",
      tables_count: 142,
      version: "0.2.0",
    });

    expect(reg.ok).toBe(true);
    expect(reg.agent.pair_code).toBe("XYZ123");
    expect(reg.agent.tables_count).toBe(142);

    const status = service.getStatus("XYZ123");
    expect(status.connected).toBe(true);
    expect(status.agent?.database).toBe("MIKRO_DB_2026");
  });

  it("poll cagrisinda bekleyen sorgu yoksa idle doner", () => {
    const service = new AgentBridgeService();
    service.registerAgent({
      pair_code: "ABC789",
      db_type: "postgresql",
      host: "localhost",
      port: 5432,
      database: "odoo",
      tables_count: 85,
    });

    const pollRes = service.poll({ pair_code: "ABC789" });
    expect(pollRes.status).toBe("idle");
    expect(pollRes.query).toBeUndefined();
  });

  it("dispatchQuery ile gonderilen sorguyu poll sirasinda iletir ve sonuc dondurur", async () => {
    const service = new AgentBridgeService();
    service.registerAgent({
      pair_code: "ERP456",
      db_type: "mysql",
      database: "ecommerce",
    });

    // Query gonder (arkaplanda bekler)
    const queryPromise = service.dispatchQuery({
      pair_code: "ERP456",
      query: "SELECT id, name, price FROM products LIMIT 5",
      timeout_ms: 2000,
    });

    // Agent poll yapar ve sorguyu alir
    const polled = service.poll({ pair_code: "ERP456" });
    expect(polled.status).toBe("pending_query");
    expect(polled.query_id).toBeDefined();
    expect(polled.query).toBe("SELECT id, name, price FROM products LIMIT 5");

    // Agent sonucu iletir
    const submitRes = service.submitResult({
      pair_code: "ERP456",
      query_id: polled.query_id!,
      result: {
        columns: ["id", "name", "price"],
        rows: [
          [1, "Urun A", 150.0],
          [2, "Urun B", 250.0],
        ],
        total: 2,
        elapsed_seconds: 0.045,
      },
    });
    expect(submitRes.ok).toBe(true);

    // queryPromise cozulmelidir
    const result = await queryPromise;
    expect(result.columns).toEqual(["id", "name", "price"]);
    expect(result.total).toBe(2);
    expect(result.rows.length).toBe(2);
  });
});
