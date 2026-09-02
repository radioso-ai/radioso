import { sql } from "kysely";

import type { ServiceAccountMutationActor } from "../../modules/machineAccess/ports.js";
import { forbidden } from "../../shared/domain/errors.js";
import type { Db } from "../../shared/infra/kysely/types.js";

/**
 * Transaction-owned authority check for service-account mutations.
 *
 * The caller's membership is locked before the mutation's state or audit
 * records are touched. Membership removal and role changes therefore either
 * commit first (and deny this operation) or wait until this operation has
 * committed, so a stale HTTP authorization result cannot mint or change a
 * credential after its actor has lost access.
 */
export class MachineAccessActorAuthorityRepository {
  async requireServiceAccountMutationAuthority(trx: Db, input: ServiceAccountMutationActor): Promise<void> {
    await this.lockMembership(trx, input.actorUserId, input.accountId);
    const membership = await trx.selectFrom("account_memberships")
      .select(["id", "role", "status"])
      .where("account_id", "=", input.accountId)
      .where("user_id", "=", input.actorUserId)
      .forUpdate()
      .executeTakeFirst();
    if (!membership || membership.status !== "active") throw forbidden();

    const workspace = await trx.selectFrom("workspaces")
      .select("id")
      .where("id", "=", input.workspaceId)
      .where("account_id", "=", input.accountId)
      .forUpdate()
      .executeTakeFirst();
    if (!workspace) throw forbidden();

    const grant = await trx.selectFrom("workspace_grants")
      .select("role")
      .where("workspace_id", "=", input.workspaceId)
      .where("user_id", "=", input.actorUserId)
      .forUpdate()
      .executeTakeFirst();
    if (membership.role !== "owner" && membership.role !== "admin" && grant?.role !== "admin") {
      throw forbidden();
    }
  }

  private async lockMembership(trx: Db, userId: string, accountId: string): Promise<void> {
    // The row lock below serializes direct role updates and deletes. This
    // account/user advisory lock also serializes the absent/recreated-member
    // case, where no membership row exists yet to lock.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`machine-service-actor:${accountId}:${userId}`}, 0))`.execute(trx);
  }
}
