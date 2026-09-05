import { randomUUID } from "node:crypto";

import type { PoolClient, QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AttemptRoutineInput,
  ConversationEvent,
  ConversationTraceStage,
  ConversationRoutineSlotCorrection,
  RoutineSlotCorrectionCandidate,
  RoutineState,
} from "@radioso/conversation-contract";
import { DefaultConversationEngine } from "@radioso/conversation-engine";

import { RoutineStateRepository } from "../../src/db/repositories/routineStateRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { createKyselyDatabase } from "../../src/shared/infra/kysely/kyselyDatabase.js";
import { applyTestMigration } from "../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReachIntegrationDatabase = async (databaseUrl?: string): Promise<boolean> => {
  if (!databaseUrl) {
    return false;
  }
  const database = new Database(databaseUrl);
  try {
    await database.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await database.close().catch(() => undefined);
  }
};

const hasReachableIntegrationDatabase = await canReachIntegrationDatabase(integrationDatabaseUrl);
const describeIfDatabase = hasReachableIntegrationDatabase ? describe : describe.skip;

const createClientBackedDatabase = (client: PoolClient): Database => {
  const pool = {
    async connect() {
      return new Proxy(client, {
        get(target, property, receiver) {
          if (property === "release") {
            return () => undefined;
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  } as Database["pool"];

  return {
  pool,
  kysely: createKyselyDatabase(pool),
  async query<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
    const result = await client.query<T>(text, params);
    return result.rows;
  },
  async queryOptional<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T | null> {
    const result = await client.query<T>(text, params);
    return result.rows[0] ?? null;
  },
  async queryOne<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T> {
    const result = await client.query<T>(text, params);
    const row = result.rows[0];
    if (!row) {
      throw new Error("Expected query to return one row");
    }
    return row;
  },
  async execute(text: string, params: unknown[] = []): Promise<number> {
    const result = await client.query(text, params);
    return result.rowCount ?? 0;
  },
  async withTransaction<T>(callback: (transactionClient: PoolClient) => Promise<T>): Promise<T> {
    await client.query("BEGIN");
    try {
      const value = await callback(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  },
  async close(): Promise<void> {},
  };
};

const mutableEmailSlots: RoutineSlotCorrectionCandidate["slots"] = [
  { id: "prospect_email", key: "prospect_email", type: "email", required: true, mutable: true },
];

// A correction port that returns a fixed candidate (the model step is faked); the engine's
// deterministic verify + the real RoutineStateRepository.save are what this test exercises.
const fixedCorrection = (rawValue: string): ConversationRoutineSlotCorrection => ({
  detect: vi.fn(async (): Promise<RoutineSlotCorrectionCandidate> => ({
    slots: mutableEmailSlots,
    slotKey: "prospect_email",
    rawValue,
  })),
  confirm: vi.fn(async () => "Updated your email."),
  rejectInvalid: vi.fn(async () => "That doesn't look like a valid email — what should I use?"),
});

const attemptInput = (
  sessionId: string,
  store: RoutineStateRepository,
  correction: ConversationRoutineSlotCorrection,
  content: string,
): AttemptRoutineInput => ({
  agent: { id: "agent_1", name: "Assistant" },
  sessionId,
  inputEvent: { id: randomUUID(), kind: "message", content },
  stores: {
    loadHistory: async () => [],
    appendEvent: async (_event: ConversationEvent) => {},
  },
  routineStore: store,
  // Unused by the correction path, but attemptRoutine requires a runner to be wired.
  routineRunner: { resume: vi.fn() },
  routineSlotCorrection: correction,
});

describeIfDatabase("post-completion slot correction (real routine_states)", () => {
  let database: Database;
  let backingDatabase: Database;
  let client: PoolClient;
  let schema: string;
  let store: RoutineStateRepository;

  beforeAll(async () => {
    backingDatabase = new Database(integrationDatabaseUrl!);
    client = await backingDatabase.pool.connect();
    schema = `routine_slot_correction_${randomUUID().replaceAll("-", "_")}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    database = createClientBackedDatabase(client);
    await applyTestMigration(database, "071_routine_states.sql");
    await database.execute("ALTER TABLE routine_states ADD COLUMN IF NOT EXISTS attempts JSONB NOT NULL DEFAULT '{}'::jsonb");
    store = new RoutineStateRepository(database.kysely, 60_000);
  });

  beforeEach(async () => {
    await database.execute("TRUNCATE routine_states");
  });

  afterAll(async () => {
    if (client) {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      client.release();
    }
    if (backingDatabase) {
      await backingDatabase.close();
    }
  });

  const seedCompleted = async (sessionId: string): Promise<void> => {
    const completed: RoutineState = {
      sessionId,
      routineId: "routine.prospect",
      path: ["s4_summary"],
      variables: { prospect_email: "old@example.com", prospect_interest: "lead capture" },
      status: "completed",
    };
    await store.save(completed);
  };

  it("patches the mutable slot in routine_states when a valid correction is verified", async () => {
    const sessionId = randomUUID();
    await seedCompleted(sessionId);

    const result = await new DefaultConversationEngine().attemptRoutine(
      attemptInput(sessionId, store, fixedCorrection("new@example.com"), "use new@example.com"),
    );

    expect(result?.response.answer).toBe("Updated your email.");
    const row = await database.queryOne<{ status: string; variables: Record<string, unknown> }>(
      `SELECT status, variables FROM routine_states WHERE session_id = $1`,
      [sessionId],
    );
    expect(row.status).toBe("completed");
    expect(row.variables).toEqual({ prospect_email: "new@example.com", prospect_interest: "lead capture" });
  });

  it("leaves routine_states unchanged and re-asks when the corrected value is invalid", async () => {
    const sessionId = randomUUID();
    await seedCompleted(sessionId);

    const result = await new DefaultConversationEngine().attemptRoutine(
      attemptInput(sessionId, store, fixedCorrection("not-an-email"), "change it to not-an-email"),
    );

    expect(result?.response.answer).toBe("That doesn't look like a valid email — what should I use?");
    const correctionStage = result?.trace.stages.find((stage: ConversationTraceStage) => stage.kind === "routine_slot_correction");
    expect(correctionStage?.status).toBe("rejected");
    const row = await database.queryOne<{ variables: Record<string, unknown> }>(
      `SELECT variables FROM routine_states WHERE session_id = $1`,
      [sessionId],
    );
    expect(row.variables.prospect_email).toBe("old@example.com");
  });
});
