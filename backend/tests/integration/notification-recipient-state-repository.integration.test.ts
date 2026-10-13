import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  NOTIFICATION_CONFIRMATION_DAILY_LIMIT,
  NotificationRecipientStateRepository,
} from "../../src/db/repositories/notificationRecipientStateRepository.js";
import { ContactSendActionHandler, type ContactNotificationMailer } from "../../src/modules/chat/services/actions/contactSendActionHandler.js";
import { EmailWebhookOperatorNotificationSink } from "../../src/modules/chat/services/actions/emailWebhookSink.js";
import { NotificationRecipientPolicyService } from "../../src/modules/operatorNotifications/notificationRecipientPolicy.js";
import { NotificationRecipientTokenSigner } from "../../src/modules/operatorNotifications/notificationRecipientToken.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("NotificationRecipientStateRepository (Postgres)", () => {
  const databaseName = `notification_recipient_${randomUUID().replaceAll("-", "")}_test`;
  let database: Database;
  let databaseUrl: string;
  let repository: NotificationRecipientStateRepository;
  const accountId = randomUUID();
  const workspaceId = randomUUID();

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: integrationDatabaseUrl });
    try {
      await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    } finally {
      await admin.end();
    }
    const url = new URL(integrationDatabaseUrl);
    url.pathname = `/${databaseName}`;
    url.searchParams.delete("options");
    databaseUrl = url.toString();
    database = new Database(databaseUrl);
    await runAllTestMigrations(database);
    await database.query(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)",
      [accountId, "Acme", `account-${accountId}@example.com`, "hash"],
    );
    await database.query(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)",
      [workspaceId, accountId, "Acme workspace", `acme-${randomUUID()}`],
    );
    repository = new NotificationRecipientStateRepository(database.kysely);
  }, 30_000);

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    const admin = new pg.Pool({ connectionString: integrationDatabaseUrl });
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    } finally {
      await admin.end().catch(() => undefined);
    }
  }, 30_000);

  it("derives confirmation from a verified active workspace member", async () => {
    const userId = randomUUID();
    await database.query(
      "INSERT INTO users (id, email, password_hash, email_verified_at) VALUES ($1, $2, $3, $4)",
      [userId, "Member@Example.com", "hash", new Date()],
    );
    await database.query(
      "INSERT INTO account_memberships (id, account_id, user_id, role, status) VALUES ($1, $2, $3, 'member', 'active')",
      [randomUUID(), accountId, userId],
    );

    await expect(repository.read({ workspaceId, emails: ["member@example.com"], now: new Date() }))
      .resolves.toEqual([{ email: "member@example.com", state: "confirmed", grandfatheredUntil: null }]);
    await expect(repository.reserveConfirmationSend({
      workspaceId,
      email: "member@example.com",
      now: new Date("2026-10-12T12:00:00.000Z"),
      force: true,
    })).resolves.toBeNull();
  });

  it("reserves no more than the workspace daily confirmation cap under concurrency", async () => {
    const now = new Date("2026-10-13T12:00:00.000Z");
    const reservations = await Promise.all(Array.from({ length: NOTIFICATION_CONFIRMATION_DAILY_LIMIT + 5 }, (_, index) =>
      repository.reserveConfirmationSend({
        workspaceId,
        email: `external-${index}@example.com`,
        now,
        force: false,
      })));

    expect(reservations.filter(Boolean)).toHaveLength(NOTIFICATION_CONFIRMATION_DAILY_LIMIT);
  });

  it("persists confirmation and revocation transitions", async () => {
    const nextDay = new Date("2026-10-14T12:00:00.000Z");
    const reservation = await repository.reserveConfirmationSend({
      workspaceId,
      email: "state@example.com",
      now: nextDay,
      force: false,
    });
    expect(reservation).not.toBeNull();

    await repository.confirm(reservation!.recipientId, reservation!.generation, nextDay);
    expect((await repository.read({ workspaceId, emails: ["state@example.com"], now: nextDay }))[0]?.state)
      .toBe("confirmed");
    await repository.revoke(reservation!.recipientId, nextDay);
    expect((await repository.read({ workspaceId, emails: ["state@example.com"], now: nextDay }))[0]?.state)
      .toBe("revoked");
  });

  it("rejects stale confirmation generations and does not re-enable a revoked recipient", async () => {
    const now = new Date("2026-10-15T12:00:00.000Z");
    const first = await repository.reserveConfirmationSend({
      workspaceId, email: "generation@example.com", now, force: false,
    });
    expect(first).not.toBeNull();
    await repository.revoke(first!.recipientId, now);
    expect(await repository.confirm(first!.recipientId, first!.generation, now)).toBe(false);

    const resent = await repository.reserveConfirmationSend({
      workspaceId, email: "generation@example.com", now: new Date(now.getTime() + 1), force: true,
    });
    expect(resent).toMatchObject({ recipientId: first!.recipientId, generation: first!.generation + 1 });
    expect(await repository.confirm(first!.recipientId, first!.generation, now)).toBe(false);
    expect(await repository.confirm(resent!.recipientId, resent!.generation, now)).toBe(true);
  });

  it("moves expired grandfathered recipients to pending while keeping in-window grace deliverable", async () => {
    const beforeDeadline = new Date("2026-11-01T12:00:00.000Z");
    const atDeadline = new Date("2026-11-02T12:00:00.000Z");
    const afterDeadline = new Date("2026-11-03T12:00:00.000Z");
    const seed = async (email: string, deadline: Date, sentAt: Date | null = null) => {
      await database.query(
        "INSERT INTO notification_recipient_confirmations (workspace_id, normalized_email, state, grandfathered_until, confirmation_sent_at) VALUES ($1, $2, 'grandfathered', $3, $4)",
        [workspaceId, email, deadline, sentAt],
      );
    };
    await seed("before-grandfather@example.com", atDeadline);
    await seed("at-grandfather@example.com", atDeadline);
    await seed("after-grandfather@example.com", atDeadline);
    await seed("resent-grandfather@example.com", atDeadline, beforeDeadline);

    const before = await repository.reserveConfirmationSend({ workspaceId, email: "before-grandfather@example.com", now: beforeDeadline, force: false });
    const at = await repository.reserveConfirmationSend({ workspaceId, email: "at-grandfather@example.com", now: atDeadline, force: false });
    const after = await repository.reserveConfirmationSend({ workspaceId, email: "after-grandfather@example.com", now: afterDeadline, force: false });
    const withoutResend = await repository.reserveConfirmationSend({ workspaceId, email: "resent-grandfather@example.com", now: afterDeadline, force: false });
    const withResend = await repository.reserveConfirmationSend({ workspaceId, email: "resent-grandfather@example.com", now: afterDeadline, force: true });

    expect((await repository.read({ workspaceId, emails: ["before-grandfather@example.com"], now: beforeDeadline }))[0]?.state).toBe("grandfathered");
    expect((await repository.read({ workspaceId, emails: ["at-grandfather@example.com", "after-grandfather@example.com"], now: afterDeadline })).map((row) => row.state))
      .toEqual(["waiting_for_confirmation", "waiting_for_confirmation"]);
    expect(withoutResend).toBeNull();
    expect(await repository.confirm(at!.recipientId, at!.generation, atDeadline)).toBe(true);
    expect(await repository.confirm(after!.recipientId, after!.generation, afterDeadline)).toBe(true);
    expect(await repository.confirm(withResend!.recipientId, withResend!.generation, afterDeadline)).toBe(true);
    expect(before).not.toBeNull();
  });

  it("keeps an earlier unsubscribe token effective after a resend changes confirmation generation", async () => {
    const now = new Date("2026-11-04T12:00:00.000Z");
    const first = await repository.reserveConfirmationSend({ workspaceId, email: "unsubscribe-generation@example.com", now, force: false });
    const signer = new NotificationRecipientTokenSigner("a deployment secret that is long enough", { now: () => now });
    const unsubscribe = signer.sign(first!.recipientId, "revoke");
    const resent = await repository.reserveConfirmationSend({ workspaceId, email: "unsubscribe-generation@example.com", now: new Date(now.getTime() + 1), force: true });

    expect(resent!.generation).toBeGreaterThan(first!.generation);
    expect(signer.verify(unsubscribe, "revoke")).toEqual({ recipientId: first!.recipientId });
    expect(await repository.revoke(first!.recipientId, now)).toBe(true);
    expect((await repository.read({ workspaceId, emails: ["unsubscribe-generation@example.com"], now }))[0]?.state).toBe("revoked");
  });

  it("serializes a confirmation and a resend behind the recipient row lock", async () => {
    const now = new Date("2026-11-05T12:00:00.000Z");
    const first = await repository.reserveConfirmationSend({ workspaceId, email: "confirm-race@example.com", now, force: false });
    expect(first).not.toBeNull();
    const barrier = new pg.Client({ connectionString: databaseUrl });
    await barrier.connect();
    try {
      await barrier.query("BEGIN");
      await barrier.query("SELECT id FROM notification_recipient_confirmations WHERE id = $1 FOR UPDATE", [first!.recipientId]);
      const confirming = repository.confirm(first!.recipientId, first!.generation, now);
      const resending = repository.reserveConfirmationSend({ workspaceId, email: "confirm-race@example.com", now: new Date(now.getTime() + 1), force: true });
      await barrier.query("COMMIT");
      const [confirmed, resent] = await Promise.all([confirming, resending]);
      const state = (await repository.read({ workspaceId, emails: ["confirm-race@example.com"], now }))[0]?.state;

      if (confirmed) {
        expect(resent).toBeNull();
        expect(state).toBe("confirmed");
      } else {
        expect(resent).not.toBeNull();
        expect(state).toBe("waiting_for_confirmation");
      }
    } finally {
      await barrier.query("ROLLBACK").catch(() => undefined);
      await barrier.end();
    }
  });

  it("serializes a revoke and a resend without restoring a stale pending row", async () => {
    const now = new Date("2026-11-06T12:00:00.000Z");
    const first = await repository.reserveConfirmationSend({ workspaceId, email: "revoke-race@example.com", now, force: false });
    expect(first).not.toBeNull();
    const barrier = new pg.Client({ connectionString: databaseUrl });
    await barrier.connect();
    try {
      await barrier.query("BEGIN");
      await barrier.query("SELECT id FROM notification_recipient_confirmations WHERE id = $1 FOR UPDATE", [first!.recipientId]);
      const revoking = repository.revoke(first!.recipientId, now);
      const resending = repository.reserveConfirmationSend({ workspaceId, email: "revoke-race@example.com", now: new Date(now.getTime() + 1), force: true });
      await barrier.query("COMMIT");
      await Promise.all([revoking, resending]);
      const row = await database.query<{ state: string; requires_confirmation: boolean; revoked_at: Date | null }>(
        "SELECT state, requires_confirmation, revoked_at FROM notification_recipient_confirmations WHERE id = $1",
        [first!.recipientId],
      );

      if (row[0]?.state === "pending") {
        expect(row[0]).toMatchObject({ requires_confirmation: true, revoked_at: null });
      } else {
        expect(row[0]?.state).toBe("revoked");
      }
    } finally {
      await barrier.query("ROLLBACK").catch(() => undefined);
      await barrier.end();
    }
  });

  it("applies a suppression deployment-wide and lets complaint dominate hard bounce", async () => {
    const otherWorkspaceId = randomUUID();
    await database.query(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)",
      [otherWorkspaceId, accountId, "Other", `other-${randomUUID()}`],
    );
    await repository.suppress({ email: "Bounce@Example.com", reason: "hard_bounce", provider: "resend", providerEventId: "evt-1" });
    await repository.suppress({ email: "bounce@example.com", reason: "complaint", provider: "resend", providerEventId: "evt-2" });

    expect((await repository.read({ workspaceId: otherWorkspaceId, emails: ["bounce@example.com"], now: new Date() }))[0]?.state)
      .toBe("suppressed");
  });

  it("composes real recipient state into contact and routine-notice mail delivery", async () => {
    const email = "unconfirmed-composed@example.com";
    const now = new Date("2026-10-20T12:00:00.000Z");
    const sent: string[] = [];
    const policy = new NotificationRecipientPolicyService({
      enabled: true,
      states: repository,
      sendConfirmation: async () => ({ dispatched: true }),
      now: () => now,
    });
    const mailer: ContactNotificationMailer = { send: async (message) => { sent.push(message.to); } };
    const contact = new ContactSendActionHandler(
      mailer,
      { resolve: async () => ({ emails: [email], webhook: null }) },
      undefined,
      undefined,
      undefined,
      undefined,
      policy,
    );
    const notice = new EmailWebhookOperatorNotificationSink(
      mailer,
      { resolve: async () => ({ emails: [email], webhook: null, via: "agent_setting", recipientsFromWorkspaceOwner: false }) },
      undefined,
      undefined,
      undefined,
      undefined,
      policy,
    );

    await expect(contact.handle({
      payload: { message: "Please call me" },
      context: { requestId: randomUUID(), workspaceId, accountId: accountId, conversationId: randomUUID(), idempotencyKey: randomUUID(), attempt: 1, skillName: null },
    })).rejects.toMatchObject({ reason: "notification_recipient_unconfirmed" });
    await notice.deliver({ kind: "completion", workspaceId, conversationId: randomUUID(), agentId: randomUUID(), reason: "routine_complete" }, {
      requestId: randomUUID(), workspaceId, conversationId: randomUUID(), idempotencyKey: randomUUID(), attempt: 1,
    });

    expect(sent).toEqual([]);
  });
});
