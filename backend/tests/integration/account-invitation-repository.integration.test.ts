import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountInvitationRepository } from "../../src/db/repositories/accountInvitationRepository.js";
import { Database } from "../../src/shared/infra/database.js";

// Real-Postgres characterization of AccountInvitationRepository: pending-only lookup,
// token-hash lookup, DESC ordering, and the partial update (status/accepted_at/
// accepted_by_user_id) that the Kysely migration must preserve.

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReach = async (url?: string): Promise<boolean> => {
  if (!url) {
    return false;
  }
  const database = new Database(url);
  try {
    await database.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await database.close().catch(() => undefined);
  }
};

const describeIfDatabase = (await canReach(integrationDatabaseUrl)) ? describe : describe.skip;

describeIfDatabase("AccountInvitationRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new AccountInvitationRepository(database.kysely);

  const accountId = randomUUID();
  const inviterUserId = randomUUID();
  const accepterUserId = randomUUID();
  const membershipId = randomUUID();
  const inviteEmail = `invitee-${randomUUID()}@example.com`;
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Invite Co", `acct-${accountId}@example.com`, "hash"],
    );
    await database.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`, [
      inviterUserId,
      `inviter-${inviterUserId}@example.com`,
      "hash",
    ]);
    await database.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`, [
      accepterUserId,
      `accepter-${accepterUserId}@example.com`,
      "hash",
    ]);
    await database.query(
      `INSERT INTO account_memberships (id, account_id, user_id, role, status) VALUES ($1, $2, $3, $4, $5)`,
      [membershipId, accountId, inviterUserId, "owner", "active"],
    );
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database
      .query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[inviterUserId, accepterUserId]])
      .catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  let invitationId: string;

  it("create inserts a pending invitation with defaults", async () => {
    const invitation = await repository.create({
      accountId,
      email: inviteEmail,
      invitedByMembershipId: membershipId,
      tokenHash: "invite-hash-1",
      role: "member",
      expiresAt,
    });
    invitationId = invitation.id;

    expect(invitation.status).toBe("pending");
    expect(invitation.role).toBe("member");
    expect(invitation.acceptedAt).toBeNull();
    expect(invitation.acceptedByUserId).toBeNull();
    expect(invitation.expiresAt).toBeInstanceOf(Date);
  });

  it("findPendingByAccountAndEmail returns the latest pending invitation", async () => {
    const found = await repository.findPendingByAccountAndEmail(accountId, inviteEmail);
    expect(found?.id).toBe(invitationId);

    const missing = await repository.findPendingByAccountAndEmail(accountId, `none-${randomUUID()}@x.com`);
    expect(missing).toBeNull();
  });

  it("findByTokenHash returns the invitation and null when unknown", async () => {
    const found = await repository.findByTokenHash("invite-hash-1");
    expect(found?.id).toBe(invitationId);

    expect(await repository.findByTokenHash("no-such-hash")).toBeNull();
  });

  it("listByAccount returns invitations ordered DESC by created_at", async () => {
    const second = await repository.create({
      accountId,
      email: `another-${randomUUID()}@example.com`,
      invitedByMembershipId: membershipId,
      tokenHash: "invite-hash-2",
      role: "admin",
      expiresAt,
    });

    const rows = await repository.listByAccount(accountId);
    expect(rows[0]?.id).toBe(second.id);
    expect(rows.map((r) => r.id)).toContain(invitationId);
  });

  it("update sets status, accepted_at and accepted_by_user_id", async () => {
    const acceptedAt = new Date();
    const updated = await repository.update({
      id: invitationId,
      status: "accepted",
      acceptedAt,
      acceptedByUserId: accepterUserId,
    });

    expect(updated.status).toBe("accepted");
    expect(updated.acceptedAt?.getTime()).toBe(acceptedAt.getTime());
    expect(updated.acceptedByUserId).toBe(accepterUserId);

    // pending lookup must now skip it
    expect(await repository.findPendingByAccountAndEmail(accountId, inviteEmail)).toBeNull();
  });

  it("update can clear accepted fields back to null", async () => {
    const updated = await repository.update({ id: invitationId, status: "revoked" });
    expect(updated.status).toBe("revoked");
    expect(updated.acceptedAt).toBeNull();
    expect(updated.acceptedByUserId).toBeNull();
  });
});
