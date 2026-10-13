import type { Kysely, Transaction } from "kysely";

import type { DB } from "../../shared/infra/kysely/schema.js";
import type { AuthFunnelRepositoryPort } from "../../modules/auth/services/authFunnelService.js";

type AuthFunnelTransaction = Transaction<DB>;

const findActiveAccountId = async (
  transaction: AuthFunnelTransaction,
  userId: string,
  preferredAccountId?: string,
): Promise<string | null> => {
  let query = transaction
    .selectFrom("account_memberships")
    .select("account_id")
    .where("user_id", "=", userId)
    .where("status", "=", "active");
  if (preferredAccountId) {
    query = query.where("account_id", "=", preferredAccountId);
  }
  const membership = await query.orderBy("created_at", "asc").limit(1).executeTakeFirst();
  return membership?.account_id ?? null;
};

const createSession = async (
  transaction: AuthFunnelTransaction,
  input: {
    sessionId: string;
    userId: string;
    accountId: string;
    sessionTokenHash: string;
    sessionExpiresAt: Date;
  },
): Promise<void> => {
  await transaction.insertInto("sessions").values({
    id: input.sessionId,
    user_id: input.userId,
    account_id: input.accountId,
    session_token_hash: input.sessionTokenHash,
    expires_at: input.sessionExpiresAt,
  }).executeTakeFirstOrThrow();
};

export class AuthFunnelRepository implements AuthFunnelRepositoryPort {
  constructor(private readonly db: Kysely<DB>) {}

  async createPendingTicket(input: {
    id: string;
    userId: string;
    accountId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void> {
    await this.db.insertInto("pending_registration_tickets").values({
      id: input.id,
      user_id: input.userId,
      account_id: input.accountId,
      token_hash: input.tokenHash,
      expires_at: input.expiresAt,
    }).executeTakeFirstOrThrow();
  }

  async verifyEmailAndCreateSession(input: {
    verificationTokenHash: string;
    sessionId: string;
    sessionTokenHash: string;
    sessionExpiresAt: Date;
    now: Date;
  }): Promise<{ userId: string; accountId: string } | null> {
    return this.db.transaction().execute(async (transaction) => {
      // Resolve the owner without locking the credential first. Every
      // mutating auth path then locks the user before it rechecks a credential,
      // which gives recovery and verification one consistent lock order.
      const token = await transaction
        .selectFrom("email_verification_tokens")
        .select(["id", "user_id"])
        .where("token_hash", "=", input.verificationTokenHash)
        .where("used_at", "is", null)
        .where("expires_at", ">", input.now)
        .executeTakeFirst();
      if (!token) return null;

      const user = await transaction
        .selectFrom("users")
        .select("id")
        .where("id", "=", token.user_id)
        .where("disabled_at", "is", null)
        .where("email_verified_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (!user) return null;

      const lockedToken = await transaction
        .selectFrom("email_verification_tokens")
        .select(["id", "user_id"])
        .where("id", "=", token.id)
        .where("token_hash", "=", input.verificationTokenHash)
        .where("used_at", "is", null)
        .where("expires_at", ">", input.now)
        .forUpdate()
        .executeTakeFirst();
      if (!lockedToken) return null;

      const latest = await transaction
        .selectFrom("email_verification_tokens")
        .select("id")
        .where("user_id", "=", user.id)
        .where("used_at", "is", null)
        .where("expires_at", ">", input.now)
        .orderBy("created_at", "desc")
        .limit(1)
        .executeTakeFirst();
      if (latest?.id !== lockedToken.id) return null;
      const accountId = await findActiveAccountId(transaction, user.id);
      if (!accountId) return null;

      const verified = await transaction.updateTable("users").set({
        email_verified_at: input.now,
        updated_at: input.now,
      }).where("id", "=", user.id).where("email_verified_at", "is", null).executeTakeFirst();
      if (Number(verified.numUpdatedRows) !== 1) return null;
      await transaction.updateTable("email_verification_tokens").set({ used_at: input.now })
        .where("user_id", "=", user.id)
        .where("used_at", "is", null)
        .execute();
      await transaction.updateTable("pending_registration_tickets")
        .set({ activated_at: input.now })
        .where("user_id", "=", user.id)
        .where("used_at", "is", null)
        .where("expires_at", ">", input.now)
        .execute();
      await createSession(transaction, { ...input, userId: user.id, accountId });
      return { userId: user.id, accountId };
    });
  }

  async exchangePendingTicket(input: {
    pendingTokenHash: string;
    sessionId: string;
    sessionTokenHash: string;
    sessionExpiresAt: Date;
    now: Date;
  }): Promise<{ userId: string; accountId: string } | null> {
    return this.db.transaction().execute(async (transaction) => {
      const ticket = await transaction
        .selectFrom("pending_registration_tickets")
        .select(["id", "user_id", "account_id"])
        .where("token_hash", "=", input.pendingTokenHash)
        .where("used_at", "is", null)
        .where("expires_at", ">", input.now)
        .executeTakeFirst();
      if (!ticket) return null;

      const user = await transaction
        .selectFrom("users")
        .select("id")
        .where("id", "=", ticket.user_id)
        .where("disabled_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (!user) return null;

      const lockedTicket = await transaction
        .selectFrom("pending_registration_tickets")
        .select(["id", "account_id"])
        .where("id", "=", ticket.id)
        .where("token_hash", "=", input.pendingTokenHash)
        .where("used_at", "is", null)
        .where("activated_at", "is not", null)
        .where("expires_at", ">", input.now)
        .forUpdate()
        .executeTakeFirst();
      if (!lockedTicket) return null;
      const accountId = await findActiveAccountId(transaction, user.id, lockedTicket.account_id);
      if (!accountId) return null;

      const consumed = await transaction.updateTable("pending_registration_tickets")
        .set({ used_at: input.now })
        .where("id", "=", lockedTicket.id)
        .where("used_at", "is", null)
        .executeTakeFirst();
      if (Number(consumed.numUpdatedRows) !== 1) return null;
      await createSession(transaction, { ...input, userId: user.id, accountId });
      return { userId: user.id, accountId };
    });
  }

  async revokePendingRegistrationCredentials(input: { userId: string; now: Date }): Promise<void> {
    await this.db.transaction().execute(async (transaction) => {
      const user = await transaction
        .selectFrom("users")
        .select("id")
        .where("id", "=", input.userId)
        .forUpdate()
        .executeTakeFirst();
      if (!user) return;

      await transaction.updateTable("sessions")
        .set({ revoked_at: input.now })
        .where("user_id", "=", user.id)
        .where("revoked_at", "is", null)
        .execute();
      await transaction.updateTable("email_verification_tokens")
        .set({ used_at: input.now })
        .where("user_id", "=", user.id)
        .where("used_at", "is", null)
        .execute();
      await transaction.updateTable("pending_registration_tickets")
        .set({ used_at: input.now })
        .where("user_id", "=", user.id)
        .where("used_at", "is", null)
        .execute();
    });
  }
}
