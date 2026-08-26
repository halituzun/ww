import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {
  AgentPollInput,
  AgentQueryInput,
  AgentRegisterInput,
  AgentResultInput,
  PairedAgentState,
  PendingQuery,
} from "./agent-bridge.types.js";

@Injectable()
export class AgentBridgeService {
  private readonly logger = new Logger(AgentBridgeService.name);
  private readonly pairedAgents = new Map<string, PairedAgentState>();
  private readonly queryQueues = new Map<string, Array<{ query_id: string; query: string }>>();
  private readonly pendingQueries = new Map<string, PendingQuery>();

  registerAgent(input: AgentRegisterInput): { ok: boolean; message: string; agent: PairedAgentState } {
    const now = new Date().toISOString();
    const state: PairedAgentState = {
      pair_code: input.pair_code.toUpperCase(),
      db_type: input.db_type.toLowerCase(),
      host: input.host,
      port: input.port,
      database: input.database,
      tables_count: input.tables_count ?? 0,
      version: input.version ?? "0.2.0",
      registered_at: now,
      last_heartbeat_at: now,
      status: "ready",
    };

    this.pairedAgents.set(state.pair_code, state);
    if (!this.queryQueues.has(state.pair_code)) {
      this.queryQueues.set(state.pair_code, []);
    }

    this.logger.log(
      `Agent eslestirildi: ${state.pair_code} -> ${state.db_type}://${state.host}:${state.port}/${state.database}`,
    );

    return {
      ok: true,
      message: "Agent basariyla eslestirildi.",
      agent: state,
    };
  }

  poll(input: AgentPollInput): { status: string; query_id?: string; query?: string } {
    const code = input.pair_code.toUpperCase();
    const now = new Date().toISOString();

    const agent = this.pairedAgents.get(code);
    if (agent) {
      agent.last_heartbeat_at = now;
      agent.status = input.status ?? "ready";
    } else {
      // Auto-register minimal state if poll arrives before register
      this.pairedAgents.set(code, {
        pair_code: code,
        db_type: input.db_type ?? "unknown",
        host: "127.0.0.1",
        port: 1433,
        database: "unknown",
        tables_count: 0,
        version: input.version ?? "0.2.0",
        registered_at: now,
        last_heartbeat_at: now,
        status: input.status ?? "ready",
      });
    }

    const queue = this.queryQueues.get(code);
    if (queue && queue.length > 0) {
      const nextQuery = queue.shift();
      if (nextQuery) {
        return {
          status: "pending_query",
          query_id: nextQuery.query_id,
          query: nextQuery.query,
        };
      }
    }

    return { status: "idle" };
  }

  submitResult(input: AgentResultInput): { ok: boolean; message: string } {
    const queryId = input.query_id;
    const pending = this.pendingQueries.get(queryId);

    if (!pending) {
      this.logger.warn(`Bilinmeyen veya suresi dolmus sorgu sonucu alindi: ${queryId}`);
      return { ok: false, message: "Sorgu bulunamadi veya suresi dolmus." };
    }

    this.pendingQueries.delete(queryId);
    pending.resolve(input.result);
    return { ok: true, message: "Sonuc basariyla islendi." };
  }

  async dispatchQuery(input: AgentQueryInput): Promise<AgentResultInput["result"]> {
    const code = input.pair_code.toUpperCase();
    const agent = this.pairedAgents.get(code);

    if (!agent) {
      throw new Error(`Bu eslesme koduna sahip aktif bir agent bulunamadi: ${code}`);
    }

    const queryId = randomUUID();
    const timeoutMs = input.timeout_ms ?? 15000;

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        if (this.pendingQueries.has(queryId)) {
          this.pendingQueries.delete(queryId);
          reject(new Error(`Sorgu zaman asimina ugradi (${timeoutMs}ms): ${queryId}`));
        }
      }, timeoutMs);

      const pending: PendingQuery = {
        query_id: queryId,
        pair_code: code,
        query: input.query,
        created_at: Date.now(),
        timeout_ms: timeoutMs,
        resolve: (res) => {
          clearTimeout(timeoutHandle);
          resolve(res);
        },
        reject: (err) => {
          clearTimeout(timeoutHandle);
          reject(err);
        },
      };

      this.pendingQueries.set(queryId, pending);

      if (!this.queryQueues.has(code)) {
        this.queryQueues.set(code, []);
      }
      this.queryQueues.get(code)!.push({ query_id: queryId, query: input.query });
    });
  }

  getStatus(pairCode: string): { connected: boolean; agent?: PairedAgentState } {
    const code = pairCode.toUpperCase();
    const agent = this.pairedAgents.get(code);
    if (!agent) {
      return { connected: false };
    }

    const lastSeenMs = Date.now() - new Date(agent.last_heartbeat_at).getTime();
    const isAlive = lastSeenMs < 30000;

    return {
      connected: isAlive,
      agent: {
        ...agent,
        status: isAlive ? agent.status : "offline",
      },
    };
  }
}
