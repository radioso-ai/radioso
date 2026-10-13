import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { NotificationRecipientStateRepository } from "../../src/db/repositories/notificationRecipientStateRepository.js";
import { ContactSendActionHandler, type ContactNotificationMailer } from "../../src/modules/chat/services/actions/contactSendActionHandler.js";
import { EmailWebhookOperatorNotificationSink } from "../../src/modules/chat/services/actions/emailWebhookSink.js";
import {
  NOTIFICATION_CONFIRMATION_LIMITS,
  NotificationRecipientPolicyService,
} from "../../src/modules/operatorNotifications/notificationRecipientPolicy.js";
import { NotificationRecipientTokenSigner } from "../../src/modules/operatorNotifications/notificationRecipientToken.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const DAY_MS = 24 * 60 * 60 * 1000;

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
    await expect(repository.reserveConfirmationSend({ limits: NOTIFICATION_CONFIRMATION_LIMITS,
      workspaceId,
      email: "member@example.com",
      now: new Date("2026-10-12T12:00:00.000Z"),
      force: true,
    })).resolves.toBeNull();
  });

  it("keeps member confirmation derived, so an address that leaves the workspace must confirm", async () => {
    const userId = randomUUID();
    const membershipId = randomUUID();
    await database.query(
      "INSERT INTO users (id, email, password_hash, email_verified_at) VALUES ($1, $2, $3, $4)",
      [userId, "leaver@example.com", "hash", new Date()],
    );
    await database.query(
      "INSERT INTO account_memberships (id, account_id, user_id, role, status) VALUES ($1, $2, $3, 'member', 'active')",
      [membershipId, accountId, userId],
    );
    await repository.ensure(workspaceId, "leaver@example.com");
    expect((await repository.read({ workspaceId, emails: ["leaver@example.com"], now: new Date() }))[0]?.state).toBe("confirmed");

    await database.query("DELETE FROM account_memberships WHERE id = $1", [membershipId]);

    expect((await repository.read({ workspaceId, emails: ["leaver@example.com"], now: new Date() }))[0]?.state)
      .toBe("waiting_for_confirmation");
  });

  it("reserves no more than the workspace daily confirmation cap under concurrency", async () => {
    const now = new Date("2026-10-13T12:00:00.000Z");
    const reservations = await Promise.all(Array.from({ length: NOTIFICATION_CONFIRMATION_LIMITS.dailySends + 5 }, (_, index) =>
      repository.reserveConfirmationSend({ limits: NOTIFICATION_CONFIRMATION_LIMITS,
        workspaceId,
        email: `external-${index}@example.com`,
        now,
        force: false,
      })));

    expect(reservations.filter(Boolean)).toHaveLength(NOTIFICATION_CONFIRMATION_LIMITS.dailySends);
  });

  it("persists confirmation and revocation transitions", async () => {
    const nextDay = new Date("2026-10-14T12:00:00.000Z");
    const reservation = await repository.reserveConfirmationSend({ limits: NOTIFICATION_CONFIRMATION_LIMITS,
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

  it("rejects stale confirmation generations and never re-solicits a revoked recipient", async () => {
    const now = new Date("2026-10-15T12:00:00.000Z");
    const first = await repository.reserveConfirmationSend({ limits: NOTIFICATION_CONFIRMATION_LIMITS,
      workspaceId, email: "generation@example.com", now, force: false,
    });
    expect(first).not.toBeNull();
    const second = await repository.reserveConfirmationSend({ limits: NOTIFICATION_CONFIRMATION_LIMITS,
      workspaceId, email: "generation@example.com", now: new Date(now.getTime() + 2 * DAY_MS), force: true,
    });
    expect(second).toMatchObject({ recipientId: first!.recipientId, generation: first!.generation + 1 });
    expect(await repository.confirm(first!.recipientId, first!.generation, now)).toBe(false);

    await repository.revoke(first!.recipientId, now);
    expect(await repository.confirm(second!.recipientId, second!.generation, now)).toBe(false);
    await expect(repository.reserveConfirmationSend({ limits: NOTIFICATION_CONFIRMATION_LIMITS,
      workspaceId, email: "generation@example.com", now: new Date(now.getTime() + 10 * DAY_MS), force: true,
    })).resolves.toBeNull();
  });

  it("spaces forced resends to one address at least a day apart", async () => {
    const now = new Date("2026-10-16T12:00:00.000Z");
    const first = await repository.reserveConfirmationSend({ limits: NOTIFICATION_CONFIRMATION_LIMITS,
      workspaceId, email: "cooldown@example.com", now, force: false,
    });
    expect(first).not.toBeNull();

    await expect(repository.reserveConfirmationSend({ limits: NOTIFICATION_CONFIRMATION_LIMITS,
      workspaceId, email: "cooldown@example.com", now: new Date(now.getTime() + DAY_MS - 1), force: true,
    })).resolves.toBeNull();
    await expect(repository.reserveConfirmationSend({ limits: NOTIFICATION_CONFIRMATION_LIMITS,
      workspaceId, email: "cooldown@example.com", now: new Date(now.getTime() + DAY_MS), force: true,
    })).resolves.toMatchObject({ recipientId: first!.recipientId });
  });

  it("lets a recipient resume notifications they stopped", async () => {
    const now = new Date("2026-10-17T12:00:00.000Z");
    const reservation = await repository.reserveConfirmationSend({ limits: NOTIFICATION_CONFIRMATION_LIMITS,
      workspaceId, email: "resume@example.com", now, force: false,
    });
    expect(await repository.resume(reservation!.recipientId, now)).toBe(false);

    await repository.revoke(reservation!.recipientId, now);
    expect(await repository.resume(reservation!.recipientId, now)).toBe(true);
    expect((await repository.read({ workspaceId, emails: ["resume@example.com"], now }))[0]?.state).toBe("confirmed");
  });

  it("confirms a grandfathered recipient whose link arrived before the grace deadline", async () => {
    const deadline = new Date("2026-10-30T12:00:00.000Z");
    await database.query(
      "INSERT INTO notification_recipient_confirmations (workspace_id, normalized_email, state, grandfathered_until) VALUES ($1, $2, 'grandfathered', $3)",
      [workspaceId, "late-click@example.com", deadline],
    );
    const reservation = await repository.reserveConfirmationSend({ limits: NOTIFICATION_CONFIRMATION_LIMITS,
      workspaceId, email: "late-click@example.com", now: new Date(deadline.getTime() - DAY_MS), force: false,
    });
    expect(reservation).not.toBeNull();

    expect(await repository.confirm(reservation!.recipientId, reservation!.generation, new Date(deadline.getTime() + DAY_MS)))
      .toBe(true);
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

    const before = await repository.reserveConfirmationSend({ limits: NOTIFICATION_CONFIRMATION_LIMITS, workspaceId, email: "before-grandfather@example.com", now: beforeDeadline, force: false });
    const at = await repository.reserveConfirmationSend({ limits: NOTIFICATION_CONFIRMATION_LIMITS, workspaceId, email: "at-grandfather@example.com", now: atDeadline, force: false });
    const after = await repository.reserveConfirmationSend({ limits: NOTIFICATION_CONFIRMATION_LIMITS, workspaceId, email: "after-grandfather@example.com", now: afterDeadline, force: false });
    const withoutResend = await repository.reserveConfirmationSend({ limits: NOTIFICATION_CONFIRMATION_LIMITS, workspaceId, email: "resent-grandfather@example.com", now: afterDeadline, force: false });
    const withResend = await repository.reserveConfirmationSend({ limits: NOTIFICATION_CONFIRMATION_LIMITS, workspaceId, email: "resent-grandfather@example.com", now: afterDeadline, force: true });

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
    const first = await repository.reserveConfirmationSend({ limits: NOTIFICATION_CONFIRMATION_LIMITS, workspaceId, email: "unsubscribe-generation@example.com", now, force: false });
    const signer = new NotificationRecipientTokenSigner("a deployment secret that is long enough", { now: () => now });
    const unsubscribe = signer.sign(first!.recipientId, "revoke");
    const resent = await repository.reserveConfirmationSend({ limits: NOTIFICATION_CONFIRMATION_LIMITS, workspaceId, email: "unsubscribe-generation@example.com", now: new Date(now.getTime() + DAY_MS), force: true });

    expect(resent!.generation).toBeGreaterThan(first!.generation);
    expect(signer.verify(unsubscribe, "revoke")).toEqual({ recipientId: first!.recipientId });
    expect(await repository.revoke(first!.recipientId, now)).toBe(true);
    expect((await repository.read({ workspaceId, emails: ["unsubscribe-generation@example.com"], now }))[0]?.state).toBe("revoked");
  });

  it("serializes a confirmation and a resend behind the recipient row lock", async () => {
    const now = new Date("2026-11-05T12:00:00.000Z");
    const first = await repository.reserveConfirmationSend({ limits: NOTIFICATION_CONFIRMATION_LIMITS, workspaceId, email: "confirm-race@example.com", now, force: false });
    expect(first).not.toBeNull();
    const barrier = new pg.Client({ connectionString: databaseUrl });
    await barrier.connect();
    try {
      await barrier.query("BEGIN");
      await barrier.query("SELECT id FROM notification_recipient_confirmations WHERE id = $1 FOR UPDATE", [first!.recipientId]);
      const confirming = repository.confirm(first!.recipientId, first!.generation, now);
      const resending = repository.reserveConfirmationSend({ limits: NOTIFICATION_CONFIRMATION_LIMITS, workspaceId, email: "confirm-race@example.com", now: new Date(now.getTime() + DAY_MS), force: true });
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

  it("serializes a revoke and a resend so a stopped recipient stays stopped", async () => {
    const now = new Date("2026-11-06T12:00:00.000Z");
    const first = await repository.reserveConfirmationSend({ limits: NOTIFICATION_CONFIRMATION_LIMITS, workspaceId, email: "revoke-race@example.com", now, force: false });
    expect(first).not.toBeNull();
    const barrier = new pg.Client({ connectionString: databaseUrl });
    await barrier.connect();
    try {
      await barrier.query("BEGIN");
      await barrier.query("SELECT id FROM notification_recipient_confirmations WHERE id = $1 FOR UPDATE", [first!.recipientId]);
      const revoking = repository.revoke(first!.recipientId, now);
      const resending = repository.reserveConfirmationSend({ limits: NOTIFICATION_CONFIRMATION_LIMITS, workspaceId, email: "revoke-race@example.com", now: new Date(now.getTime() + DAY_MS), force: true });
      await barrier.query("COMMIT");
      const [, resent] = await Promise.all([revoking, resending]);
      const row = await database.query<{ state: string }>(
        "SELECT state FROM notification_recipient_confirmations WHERE id = $1",
        [first!.recipientId],
      );

      expect(row[0]?.state).toBe("revoked");
      if (resent) expect(await repository.confirm(resent.recipientId, resent.generation, now)).toBe(false);
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
