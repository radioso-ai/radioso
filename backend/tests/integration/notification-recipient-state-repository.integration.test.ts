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
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("NotificationRecipientStateRepository (Postgres)", () => {
  const databaseName = `notification_recipient_${randomUUID().replaceAll("-", "")}_test`;
  let database: Database;
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
    database = new Database(url.toString());
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
    await repository.revoke(reservation!.recipientId, reservation!.generation, nextDay);
    expect((await repository.read({ workspaceId, emails: ["state@example.com"], now: nextDay }))[0]?.state)
      .toBe("revoked");
  });

  it("rejects stale confirmation generations and does not re-enable a revoked recipient", async () => {
    const now = new Date("2026-10-15T12:00:00.000Z");
    const first = await repository.reserveConfirmationSend({
      workspaceId, email: "generation@example.com", now, force: false,
    });
    expect(first).not.toBeNull();
    await repository.revoke(first!.recipientId, first!.generation, now);
    expect(await repository.confirm(first!.recipientId, first!.generation, now)).toBe(false);

    const resent = await repository.reserveConfirmationSend({
      workspaceId, email: "generation@example.com", now: new Date(now.getTime() + 1), force: true,
    });
    expect(resent).toMatchObject({ recipientId: first!.recipientId, generation: first!.generation + 1 });
    expect(await repository.confirm(first!.recipientId, first!.generation, now)).toBe(false);
    expect(await repository.confirm(resent!.recipientId, resent!.generation, now)).toBe(true);
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
