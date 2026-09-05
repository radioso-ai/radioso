import { randomUUID } from "node:crypto";

import type { FederatedIdentityRepositoryPort } from "../../modules/auth/services/authService.js";
import type { Db } from "../../shared/infra/kysely/types.js";

export interface UserFederatedIdentityRecord {
  id: string;
  userId: string;
  provider: string;
  subject: string;
  providerEmail: string;
  createdAt: Date;
  lastAuthenticatedAt: Date;
}

interface UserFederatedIdentityRow {
  id: string;
  user_id: string;
  provider: string;
  subject: string;
  provider_email: string;
  created_at: Date;
  last_authenticated_at: Date;
}

const userFederatedIdentityColumns = [
  "id",
  "user_id",
  "provider",
  "subject",
  "provider_email",
  "created_at",
  "last_authenticated_at",
] as const;

const mapUserFederatedIdentity = (row: UserFederatedIdentityRow): UserFederatedIdentityRecord => ({
  id: row.id,
  userId: row.user_id,
  provider: row.provider,
  subject: row.subject,
  providerEmail: row.provider_email,
  createdAt: new Date(row.created_at),
  lastAuthenticatedAt: new Date(row.last_authenticated_at),
});

// The port this satisfies is `FederatedIdentityRepositoryPort`, declared by the
// auth module that consumes it. This adapter returns the full row, which is a
// superset of what that narrow port asks for.
export class UserFederatedIdentityRepository implements FederatedIdentityRepositoryPort {
  constructor(private readonly db: Db) {}

  async findByProviderSubject(provider: string, subject: string): Promise<UserFederatedIdentityRecord | null> {
    const row = await this.db
      .selectFrom("user_federated_identities")
      .select(userFederatedIdentityColumns)
      .where("provider", "=", provider)
      .where("subject", "=", subject)
      .executeTakeFirst();

    return row ? mapUserFederatedIdentity(row) : null;
  }

  async listForUser(userId: string): Promise<UserFederatedIdentityRecord[]> {
    const rows = await this.db
      .selectFrom("user_federated_identities")
      .select(userFederatedIdentityColumns)
      .where("user_id", "=", userId)
      .orderBy("provider")
      .execute();

    return rows.map(mapUserFederatedIdentity);
  }

  async link(params: {
    userId: string;
    provider: string;
    subject: string;
    providerEmail: string;
    authenticatedAt: Date;
  }): Promise<UserFederatedIdentityRecord> {
    const row = await this.db
      .insertInto("user_federated_identities")
      .values({
        id: randomUUID(),
        user_id: params.userId,
        provider: params.provider,
        subject: params.subject,
        provider_email: params.providerEmail,
        last_authenticated_at: params.authenticatedAt,
      })
      // The subject is asserted by the provider on every sign-in, so a repeat
      // visit refreshes the address and the timestamp rather than inserting a
      // second row. `user_id` is deliberately left alone: re-pointing a provider
      // identity at a different user is an account transfer, not a refresh, and
      // no caller has a reason to do it silently.
      .onConflict((oc) =>
        oc.columns(["provider", "subject"]).doUpdateSet({
          provider_email: params.providerEmail,
          last_authenticated_at: params.authenticatedAt,
        }),
      )
      .returning(userFederatedIdentityColumns)
      .executeTakeFirstOrThrow();

    return mapUserFederatedIdentity(row);
  }

  async deleteForUser(userId: string): Promise<number> {
    const result = await this.db
      .deleteFrom("user_federated_identities")
      .where("user_id", "=", userId)
      .executeTakeFirst();

    return Number(result.numDeletedRows);
  }
}
