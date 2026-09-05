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

    // A conflicting row can become terminal after `DO NOTHING` and before the
    // lookup. In that case it no longer participates in the partial unique index,
    // so retry the insert rather than turning a valid retry into a 500.
    for (;;) {
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
        .executeTakeFirst();
      if (existing) return { status: "existing" as const, job: mapAgentBundleImport(existing as AgentBundleImportRow) };
    }
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

  async markApplying(importId: string): Promise<boolean> {
    const result = await this.db.updateTable("agent_bundle_imports")
      .set({ state: "applying", updated_at: currentTimestamp() })
      .where("id", "=", importId)
      .where("state", "=", "queued")
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async setCreatedAgent(importId: string, agentId: string): Promise<boolean> {
    const result = await this.db.updateTable("agent_bundle_imports")
      .set({ agent_id: agentId, updated_at: currentTimestamp() })
      .where("id", "=", importId)
      .where("state", "=", "applying")
      .where("cleanup_lease_token", "is", null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async markApplied(importId: string, result: { unresolved: unknown[] }): Promise<boolean> {
    const update = await this.db.updateTable("agent_bundle_imports")
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
      // Claiming a cleanup lease fences the original request. The sweep owns the
      // compensating delete from that point, so this request must not resurrect it.
      .where("cleanup_lease_token", "is", null)
      .executeTakeFirst();
    return update.numUpdatedRows > 0n;
  }

  async markFailed(importId: string, failureCode: "invalid_bundle" | "apply_failed", options: { terminal: boolean; leaseToken?: string }): Promise<boolean> {
    let query = this.db.updateTable("agent_bundle_imports")
      .set({
        ...(options.terminal ? { state: "failed" as const } : {}),
        failure_code: failureCode,
        updated_at: currentTimestamp(),
      })
      .where("id", "=", importId)
      .where("state", "in", ["queued", "applying"]);
    query = options.leaseToken
      ? query.where("cleanup_lease_token", "=", options.leaseToken)
      : query.where("cleanup_lease_token", "is", null);
    const update = await query.executeTakeFirst();
    return update.numUpdatedRows > 0n;
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
        .where("state", "in", ["queued", "applying"])
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

  async markCompensated(importId: string, leaseToken?: string): Promise<boolean> {
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
    query = leaseToken
      ? query.where("cleanup_lease_token", "=", leaseToken)
      : query.where("cleanup_lease_token", "is", null);
    const update = await query.executeTakeFirst();
    return update.numUpdatedRows > 0n;
  }

  private async insert(input: { workspaceId: string; actorAccountId: string | null; idempotencyKey: string | null }) {
    return this.db.insertInto("agent_bundle_imports")
      .values({ workspace_id: input.workspaceId, actor_account_id: input.actorAccountId, idempotency_key: input.idempotencyKey })
      .returning(agentBundleImportColumns)
      .executeTakeFirstOrThrow();
  }
}
