import type { AgentBundleImportRepositoryPort } from "../../modules/agentBundle/public.js";
import { currentTimestamp, nowMinusSeconds, nowPlusSeconds, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import { agentBundleImportColumns, mapAgentBundleImport, type AgentBundleImportRow } from "./agentBundleImportRowMapper.js";

const activeStates = ["queued", "applying", "applied"] as const;

export class AgentBundleImportRepository implements AgentBundleImportRepositoryPort {
  constructor(private readonly db: Db) {}

  async createOrGet(input: { workspaceId: string; actorAccountId: string | null; idempotencyKey: string | null }) {
    if (input.idempotencyKey === null) {
      const row = await this.insert(input);
      return { status: "created" as const, job: mapAgentBundleImport(row as unknown as AgentBundleImportRow) };
    }

    const inserted = await this.db
      .insertInto("agent_bundle_imports")
      .values({
        workspace_id: input.workspaceId,
        actor_account_id: input.actorAccountId,
        idempotency_key: input.idempotencyKey,
      })
      .onConflict((conflict) => conflict.columns(["workspace_id", "idempotency_key"])
        .where("idempotency_key", "is not", null)
        .where("state", "in", activeStates)
        .doNothing())
      .returning(agentBundleImportColumns)
      .executeTakeFirst();
    if (inserted) return { status: "created" as const, job: mapAgentBundleImport(inserted as AgentBundleImportRow) };

    const existing = await this.db
      .selectFrom("agent_bundle_imports")
      .select(agentBundleImportColumns)
      .where("workspace_id", "=", input.workspaceId)
      .where("idempotency_key", "=", input.idempotencyKey)
      .where("state", "in", activeStates)
      .executeTakeFirstOrThrow();
    return { status: "existing" as const, job: mapAgentBundleImport(existing as AgentBundleImportRow) };
  }

  async findById(workspaceId: string, importId: string) {
    const row = await this.db
      .selectFrom("agent_bundle_imports")
      .select(agentBundleImportColumns)
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", importId)
      .executeTakeFirst();
    return row ? mapAgentBundleImport(row as AgentBundleImportRow) : null;
  }

  async markApplying(importId: string): Promise<void> {
    await this.db.updateTable("agent_bundle_imports")
      .set({ state: "applying", updated_at: currentTimestamp() })
      .where("id", "=", importId)
      .where("state", "=", "queued")
      .execute();
  }

  async setCreatedAgent(importId: string, agentId: string): Promise<void> {
    await this.db.updateTable("agent_bundle_imports")
      .set({ agent_id: agentId, updated_at: currentTimestamp() })
      .where("id", "=", importId)
      .where("state", "=", "applying")
      .execute();
  }

  async markApplied(importId: string, result: { unresolved: unknown[] }): Promise<void> {
    await this.db.updateTable("agent_bundle_imports")
      .set({
        state: "applied",
        unresolved: toJsonb(result.unresolved),
        failure_code: null,
        cleanup_lease_token: null,
        cleanup_lease_expires_at: null,
        updated_at: currentTimestamp(),
        applied_at: currentTimestamp(),
      })
      .where("id", "=", importId)
      .where("state", "=", "applying")
      .execute();
  }

  async markFailed(importId: string, failureCode: "invalid_bundle" | "apply_failed", options: { terminal: boolean }): Promise<void> {
    await this.db.updateTable("agent_bundle_imports")
      .set({
        state: options.terminal ? "failed" : "applying",
        failure_code: failureCode,
        updated_at: currentTimestamp(),
      })
      .where("id", "=", importId)
      .execute();
  }

  async claimStaleApplying(input: { ageSeconds: number; leaseSeconds: number; leaseToken: string; limit: number }) {
    const rows = await this.db.updateTable("agent_bundle_imports")
      .set({
        cleanup_lease_token: input.leaseToken,
        cleanup_lease_expires_at: nowPlusSeconds(input.leaseSeconds),
        updated_at: currentTimestamp(),
      })
      .where("id", "in", (expressionBuilder) => expressionBuilder
        .selectFrom("agent_bundle_imports")
        .select("id")
        .where("state", "=", "applying")
        .where("agent_id", "is not", null)
        .where("updated_at", "<", nowMinusSeconds(input.ageSeconds))
        .where((builder) => builder.or([
          builder("cleanup_lease_expires_at", "is", null),
          builder("cleanup_lease_expires_at", "<=", currentTimestamp()),
        ]))
        .orderBy("updated_at", "asc")
        .limit(input.limit)
        .forUpdate()
        .skipLocked())
      .returning(agentBundleImportColumns)
      .execute();
    return rows.map((row) => mapAgentBundleImport(row as AgentBundleImportRow));
  }

  async markCompensated(importId: string, leaseToken?: string): Promise<void> {
    let query = this.db.updateTable("agent_bundle_imports")
      .set({
        state: "compensated",
        cleanup_lease_token: null,
        cleanup_lease_expires_at: null,
        updated_at: currentTimestamp(),
        compensated_at: currentTimestamp(),
      })
      .where("id", "=", importId)
      .where("state", "=", "applying");
    if (leaseToken) query = query.where("cleanup_lease_token", "=", leaseToken);
    await query.execute();
  }

  private async insert(input: { workspaceId: string; actorAccountId: string | null; idempotencyKey: string | null }) {
    return this.db.insertInto("agent_bundle_imports")
      .values({ workspace_id: input.workspaceId, actor_account_id: input.actorAccountId, idempotency_key: input.idempotencyKey })
      .returning(agentBundleImportColumns)
      .executeTakeFirstOrThrow();
  }
}
