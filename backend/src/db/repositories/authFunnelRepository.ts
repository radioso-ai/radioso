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

  async createRegistrationChallenge(input: {
    userId: string;
    accountId: string;
    verificationTokenId: string;
    verificationTokenHash: string;
    verificationExpiresAt: Date;
    pendingTicketId: string;
    pendingTokenHash: string;
    pendingExpiresAt: Date;
    requestIp: string | null;
    requestUserAgent: string | null;
  }): Promise<boolean> {
    return this.db.transaction().execute(async (transaction) => {
      const user = await transaction.selectFrom("users")
        .select("id")
        .where("id", "=", input.userId)
        .where("disabled_at", "is", null)
        .where("email_verified_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (!user) return false;

      await transaction.insertInto("email_verification_tokens").values({
        id: input.verificationTokenId,
        user_id: user.id,
        token_hash: input.verificationTokenHash,
        expires_at: input.verificationExpiresAt,
        request_ip: input.requestIp,
        request_user_agent: input.requestUserAgent,
      }).executeTakeFirstOrThrow();
      await transaction.insertInto("pending_registration_tickets").values({
        id: input.pendingTicketId,
        user_id: user.id,
        account_id: input.accountId,
        token_hash: input.pendingTokenHash,
        expires_at: input.pendingExpiresAt,
      }).executeTakeFirstOrThrow();
      return true;
    });
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

  async completePasswordReset(input: {
    resetTokenHash: string;
    passwordHash: string;
    now: Date;
  }): Promise<{
    userId: string;
    email: string;
    displayName: string | null;
    revokedFederatedIdentities: number;
  } | null> {
    return this.db.transaction().execute(async (transaction) => {
      const candidate = await transaction.selectFrom("password_reset_tokens")
        .select(["id", "user_id"])
        .where("token_hash", "=", input.resetTokenHash)
        .where("used_at", "is", null)
        .where("expires_at", ">", input.now)
        .executeTakeFirst();
      if (!candidate) return null;

      const user = await transaction.selectFrom("users")
        .select(["id", "email", "display_name", "email_verified_at"])
        .where("id", "=", candidate.user_id)
        .forUpdate()
        .executeTakeFirst();
      if (!user) return null;

      const token = await transaction.selectFrom("password_reset_tokens")
        .select("id")
        .where("id", "=", candidate.id)
        .where("token_hash", "=", input.resetTokenHash)
        .where("used_at", "is", null)
        .where("expires_at", ">", input.now)
        .forUpdate()
        .executeTakeFirst();
      if (!token) return null;
      const latest = await transaction.selectFrom("password_reset_tokens")
        .select("id")
        .where("user_id", "=", user.id)
        .where("used_at", "is", null)
        .where("expires_at", ">", input.now)
        .orderBy("created_at", "desc")
        .limit(1)
        .executeTakeFirst();
      if (latest?.id !== token.id) {
        await transaction.updateTable("password_reset_tokens")
          .set({ used_at: input.now })
          .where("id", "=", token.id)
          .where("used_at", "is", null)
          .executeTakeFirst();
        return null;
      }

      const consumed = await transaction.updateTable("password_reset_tokens")
        .set({ used_at: input.now })
        .where("id", "=", token.id)
        .where("used_at", "is", null)
        .executeTakeFirst();
      if (Number(consumed.numUpdatedRows) !== 1) return null;

      const displayName = user.email_verified_at ? user.display_name : null;
      await transaction.updateTable("users").set((expression) => ({
        password_hash: input.passwordHash,
        display_name: displayName,
        email_verified_at: expression.fn.coalesce("email_verified_at", expression.val(input.now)),
        updated_at: input.now,
      })).where("id", "=", user.id).executeTakeFirstOrThrow();
      await transaction.updateTable("password_reset_tokens")
        .set({ used_at: input.now })
        .where("user_id", "=", user.id)
        .where("used_at", "is", null)
        .execute();
      await this.invalidateRecoveryCredentials(transaction, user.id, input.now);
      const deleted = await transaction.deleteFrom("user_federated_identities")
        .where("user_id", "=", user.id)
        .executeTakeFirst();
      return {
        userId: user.id,
        email: user.email,
        displayName,
        revokedFederatedIdentities: Number(deleted.numDeletedRows),
      };
    });
  }

  async recoverFederatedUser(input: {
    userId: string;
    passwordHash: string;
    displayName: string | null;
    now: Date;
  }): Promise<{ recovered: boolean; displayName: string | null } | null> {
    return this.db.transaction().execute(async (transaction) => {
      const user = await transaction.selectFrom("users")
        .select(["id", "display_name", "email_verified_at"])
        .where("id", "=", input.userId)
        .forUpdate()
        .executeTakeFirst();
      if (!user) return null;
      if (user.email_verified_at) {
        return { recovered: false, displayName: user.display_name };
      }

      const recovered = await transaction.updateTable("users").set({
        password_hash: input.passwordHash,
        display_name: input.displayName,
        email_verified_at: input.now,
        updated_at: input.now,
      }).where("id", "=", user.id)
        .where("email_verified_at", "is", null)
        .executeTakeFirst();
      if (Number(recovered.numUpdatedRows) !== 1) {
        return { recovered: false, displayName: user.display_name };
      }
      await this.invalidateRecoveryCredentials(transaction, user.id, input.now);
      return { recovered: true, displayName: input.displayName };
    });
  }

  private async invalidateRecoveryCredentials(
    transaction: AuthFunnelTransaction,
    userId: string,
    now: Date,
  ): Promise<void> {
    await transaction.updateTable("sessions")
      .set({ revoked_at: now })
      .where("user_id", "=", userId)
      .where("revoked_at", "is", null)
      .execute();
    await transaction.updateTable("email_verification_tokens")
      .set({ used_at: now })
      .where("user_id", "=", userId)
      .where("used_at", "is", null)
      .execute();
    await transaction.updateTable("pending_registration_tickets")
      .set({ used_at: now })
      .where("user_id", "=", userId)
      .where("used_at", "is", null)
      .execute();
  }
}
