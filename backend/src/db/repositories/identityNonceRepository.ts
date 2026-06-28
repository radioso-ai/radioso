import type { Db } from "../../shared/infra/kysely/types.js";

export interface IdentityNonceRepositoryPort {
  isUsed(nonce: string): Promise<boolean>;
  markUsed(nonce: string, workspaceId: string, expiresAt: Date): Promise<void>;
  deleteExpired?(now: Date): Promise<number>;
}

export class IdentityNonceRepository implements IdentityNonceRepositoryPort {
  constructor(private readonly db: Db) {}

  async isUsed(nonce: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("context_identity_nonces")
      .select("nonce")
      .where("nonce", "=", nonce)
      .where("expires_at", ">", new Date())
      .executeTakeFirst();
    return Boolean(row);
  }

  async markUsed(nonce: string, workspaceId: string, expiresAt: Date): Promise<void> {
    const row = await this.db
      .insertInto("context_identity_nonces")
      .values({
        nonce,
        workspace_id: workspaceId,
        expires_at: expiresAt,
      })
      .onConflict((oc) => oc.column("nonce").doNothing())
      .returning("nonce")
      .executeTakeFirst();
    if (!row) {
      throw new Error("Identity nonce has already been used");
    }
  }

  async deleteExpired(now: Date): Promise<number> {
    const result = await this.db
      .deleteFrom("context_identity_nonces")
      .where("expires_at", "<=", now)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
