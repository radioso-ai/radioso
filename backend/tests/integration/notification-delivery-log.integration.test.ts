import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { NotificationDeliveryRepository } from "../../src/db/repositories/notificationDeliveryRepository.js";
import { NotificationRecipientIdentityRepository, NotificationRecipientStateRepository } from "../../src/db/repositories/notificationRecipientStateRepository.js";
import { UndeliveredRecipientAlertRepository } from "../../src/db/repositories/undeliveredRecipientAlertRepository.js";
import { ContactSendActionHandler } from "../../src/modules/chat/services/actions/contactSendActionHandler.js";
import {
  NotificationDeliveryLog,
  NotificationDeliveryReader,
  NotificationRecipientPolicyService,
  UNDELIVERED_ALERT_WINDOW_MS,
  UndeliveredRecipientAlerts,
} from "../../src/modules/operatorNotifications/public.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("notification delivery log (Postgres)", () => {
  const databaseName = `notification_delivery_log_${randomUUID().replaceAll("-", "")}_test`;
  let database: Database;
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const conversationId = randomUUID();
  let deliveries: NotificationDeliveryRepository;
  let states: NotificationRecipientStateRepository;
  let alertStore: UndeliveredRecipientAlertRepository;

  const addUser = async (email: string, options: { role: string; verified?: boolean; disabled?: boolean; status?: string }) => {
    const userId = randomUUID();
    await database.query(
      "INSERT INTO users (id, email, password_hash, email_verified_at, disabled_at) VALUES ($1, $2, $3, $4, $5)",
      [userId, email, "hash", options.verified === false ? null : new Date(), options.disabled ? new Date() : null],
    );
    await database.query(
      "INSERT INTO account_memberships (id, account_id, user_id, role, status) VALUES ($1, $2, $3, $4, $5)",
      [randomUUID(), accountId, userId, options.role, options.status ?? "active"],
    );
  };

  const rows = (where = "workspace_id = $1", params: unknown[] = [workspaceId]) => database.query<{
    recipient_email: string; outcome: string; kind: string; agent_id: string | null; created_at: Date; updated_at: Date;
  }>(`SELECT recipient_email, outcome, kind, agent_id, created_at, updated_at FROM notification_deliveries WHERE ${where} ORDER BY recipient_email`, params);

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
    for (const id of [workspaceId, otherWorkspaceId]) {
      await database.query(
        "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)",
        [id, accountId, "Acme workspace", `acme-${randomUUID()}`],
      );
    }
    await database.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, 'Front desk')", [agentId, workspaceId]);
    await database.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, 'Billing')", [otherAgentId, workspaceId]);
    await database.query("INSERT INTO conversations (id, workspace_id, agent_id) VALUES ($1, $2, $3)", [conversationId, workspaceId, agentId]);
    deliveries = new NotificationDeliveryRepository(database.kysely);
    states = new NotificationRecipientStateRepository(database.kysely);
    alertStore = new UndeliveredRecipientAlertRepository(database.kysely, states);
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

  beforeEach(async () => {
    await database.query("DELETE FROM notification_deliveries");
  });

  const subject = (requestId: string, overrides: Partial<Parameters<NotificationDeliveryRepository["upsert"]>[0]> = {}) => ({
    workspaceId,
    agentId: null,
    conversationId,
    requestId,
    kind: "handoff" as const,
    ...overrides,
  });

  describe("NotificationDeliveryRepository", () => {
    it("writes one row per address and takes the conversation's agent when the notice names none", async () => {
      await deliveries.upsert(subject(randomUUID(), { kind: "contact_request" }), [
        { email: "a@example.com", outcome: "sent" },
        { email: "b@example.com", outcome: "skipped_unconfirmed" },
      ]);

      expect(await rows()).toMatchObject([
        { recipient_email: "a@example.com", outcome: "sent", kind: "contact_request", agent_id: agentId },
        { recipient_email: "b@example.com", outcome: "skipped_unconfirmed", kind: "contact_request", agent_id: agentId },
      ]);
    });

    it("keeps the agent a notice names over the conversation's", async () => {
      await deliveries.upsert(subject(randomUUID(), { agentId: otherAgentId }), [{ email: "a@example.com", outcome: "sent" }]);

      expect((await rows())[0]?.agent_id).toBe(otherAgentId);
    });

    it("updates the same row when a request is retried, so a later success replaces a failure", async () => {
      const requestId = randomUUID();
      await deliveries.upsert(subject(requestId), [{ email: "a@example.com", outcome: "failed" }]);
      const [first] = await rows();

      await deliveries.upsert(subject(requestId), [{ email: "a@example.com", outcome: "sent" }]);

      const all = await rows();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ outcome: "sent" });
      expect(all[0]?.created_at.getTime()).toBe(first?.created_at.getTime());
      expect(all[0]?.updated_at.getTime()).toBeGreaterThanOrEqual(first!.updated_at.getTime());
    });

    it("does not unsay a mail that went out when a retry finds the address skipped", async () => {
      const requestId = randomUUID();
      await deliveries.upsert(subject(requestId), [{ email: "a@example.com", outcome: "sent" }]);

      await deliveries.upsert(subject(requestId), [{ email: "a@example.com", outcome: "skipped_suppressed" }]);

      expect((await rows())[0]?.outcome).toBe("sent");
    });

    it("lets a skip change to another outcome on a later attempt", async () => {
      const requestId = randomUUID();
      await deliveries.upsert(subject(requestId), [{ email: "a@example.com", outcome: "skipped_unconfirmed" }]);

      await deliveries.upsert(subject(requestId), [{ email: "a@example.com", outcome: "sent" }]);

      expect((await rows())[0]?.outcome).toBe("sent");
    });

    it("keeps different requests to the same address apart", async () => {
      await deliveries.upsert(subject(randomUUID()), [{ email: "a@example.com", outcome: "sent" }]);
      await deliveries.upsert(subject(randomUUID()), [{ email: "a@example.com", outcome: "sent" }]);

      expect(await rows()).toHaveLength(2);
    });

    it("writes nothing, and does not fail, for a conversation that no longer exists", async () => {
      await expect(deliveries.upsert(subject(randomUUID(), { conversationId: randomUUID() }), [
        { email: "a@example.com", outcome: "sent" },
      ])).resolves.toBeUndefined();

      expect(await rows()).toEqual([]);
    });

    it("rejects an outcome or kind the log does not know", async () => {
      await expect(database.query(
        `INSERT INTO notification_deliveries (workspace_id, conversation_id, request_id, kind, recipient_email, outcome)
         VALUES ($1, $2, $3, 'handoff', 'a@example.com', 'delivered')`,
        [workspaceId, conversationId, randomUUID()],
      )).rejects.toThrow();
      await expect(database.query(
        `INSERT INTO notification_deliveries (workspace_id, conversation_id, request_id, kind, recipient_email, outcome)
         VALUES ($1, $2, $3, 'newsletter', 'a@example.com', 'sent')`,
        [workspaceId, conversationId, randomUUID()],
      )).rejects.toThrow();
    });

    it("goes with its conversation and with its workspace, and outlives a deleted agent", async () => {
      const goneConversation = randomUUID();
      const goneAgent = randomUUID();
      const goneWorkspace = randomUUID();
      await database.query("INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'Gone', $3)", [goneWorkspace, accountId, `gone-${randomUUID()}`]);
      await database.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, 'Short lived')", [goneAgent, goneWorkspace]);
      await database.query("INSERT INTO conversations (id, workspace_id, agent_id) VALUES ($1, $2, $3)", [goneConversation, goneWorkspace, goneAgent]);
      await deliveries.upsert(
        { workspaceId: goneWorkspace, agentId: goneAgent, conversationId: goneConversation, requestId: randomUUID(), kind: "approval" },
        [{ email: "a@example.com", outcome: "sent" }],
      );

      await database.query("DELETE FROM agents WHERE id = $1", [goneAgent]);
      expect((await rows("workspace_id = $1", [goneWorkspace]))[0]?.agent_id).toBeNull();

      await database.query("DELETE FROM conversations WHERE id = $1", [goneConversation]);
      expect(await rows("workspace_id = $1", [goneWorkspace])).toEqual([]);

      const secondConversation = randomUUID();
      await database.query("INSERT INTO conversations (id, workspace_id) VALUES ($1, $2)", [secondConversation, goneWorkspace]);
      await deliveries.upsert(
        { workspaceId: goneWorkspace, agentId: null, conversationId: secondConversation, requestId: randomUUID(), kind: "approval" },
        [{ email: "a@example.com", outcome: "sent" }],
      );
      await database.query("DELETE FROM workspaces WHERE id = $1", [goneWorkspace]);
      expect(await rows("workspace_id = $1", [goneWorkspace])).toEqual([]);
    });
  });

  describe("NotificationDeliveryReader over the repository", () => {
    it("pages newest first without losing rows that were written together", async () => {
      const reader = new NotificationDeliveryReader(deliveries);
      // Three addresses written in one call share an instant; the next call is later.
      await deliveries.upsert(subject(randomUUID()), ["a", "b", "c"].map((name) => ({ email: `${name}@example.com`, outcome: "sent" as const })));
      await new Promise((resolve) => setTimeout(resolve, 5));
      await deliveries.upsert(subject(randomUUID()), ["d", "e"].map((name) => ({ email: `${name}@example.com`, outcome: "sent" as const })));

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page += 1) {
        const result = await reader.list(workspaceId, { limit: 2, cursor });
        seen.push(...result.items.map((item) => item.recipientEmail));
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }

      expect(seen).toHaveLength(5);
      expect(new Set(seen)).toEqual(new Set(["a", "b", "c", "d", "e"].map((name) => `${name}@example.com`)));
      expect(new Set(seen.slice(0, 2))).toEqual(new Set(["d@example.com", "e@example.com"]));
    });

    it("filters by agent and outcome and never shows another workspace's rows", async () => {
      const reader = new NotificationDeliveryReader(deliveries);
      await deliveries.upsert(subject(randomUUID(), { agentId }), [{ email: "a@example.com", outcome: "sent" }, { email: "b@example.com", outcome: "skipped_unconfirmed" }]);
      await deliveries.upsert(subject(randomUUID(), { agentId: otherAgentId }), [{ email: "c@example.com", outcome: "sent" }]);

      const forAgent = await reader.list(workspaceId, { limit: 10, agentId: otherAgentId });
      expect(forAgent.items.map((item) => item.recipientEmail)).toEqual(["c@example.com"]);

      const skipped = await reader.list(workspaceId, { limit: 10, outcome: "skipped_unconfirmed" });
      expect(skipped.items.map((item) => item.recipientEmail)).toEqual(["b@example.com"]);

      expect((await reader.list(otherWorkspaceId, { limit: 10 })).items).toEqual([]);
    });
  });

  describe("UndeliveredRecipientAlertRepository", () => {
    it("lets exactly one of several concurrent workers claim an address for the day", async () => {
      const now = new Date("2026-11-07T10:00:00.000Z");

      const claims = await Promise.all(Array.from({ length: 8 }, () =>
        alertStore.claim({ workspaceId, email: "contested@example.com", now, windowMs: UNDELIVERED_ALERT_WINDOW_MS })));

      expect(claims.filter(Boolean)).toHaveLength(1);
    });

    it("claims again only once the window has passed, and again after a release", async () => {
      const first = new Date("2026-11-08T10:00:00.000Z");
      const input = { workspaceId, email: "daily@example.com", windowMs: UNDELIVERED_ALERT_WINDOW_MS };

      const claim = await alertStore.claim({ ...input, now: first });
      expect(claim).not.toBeNull();
      expect(await alertStore.claim({ ...input, now: new Date(first.getTime() + UNDELIVERED_ALERT_WINDOW_MS - 1) })).toBeNull();

      await alertStore.release(claim!);
      expect(await alertStore.claim({ ...input, now: new Date(first.getTime() + 1_000) })).not.toBeNull();

      const later = new Date(first.getTime() + UNDELIVERED_ALERT_WINDOW_MS + 1_000);
      expect(await alertStore.claim({ ...input, now: later })).not.toBeNull();
    });

    it("throttles each workspace and address on its own", async () => {
      const now = new Date("2026-11-09T10:00:00.000Z");
      const input = { now, windowMs: UNDELIVERED_ALERT_WINDOW_MS };

      expect(await alertStore.claim({ ...input, workspaceId, email: "one@example.com" })).not.toBeNull();
      expect(await alertStore.claim({ ...input, workspaceId, email: "two@example.com" })).not.toBeNull();
      expect(await alertStore.claim({ ...input, workspaceId: otherWorkspaceId, email: "one@example.com" })).not.toBeNull();
    });

    it("lists only active, enabled, verified owners and admins", async () => {
      await addUser("owner@example.com", { role: "owner" });
      await addUser("Admin@Example.com", { role: "admin" });
      await addUser("unverified-admin@example.com", { role: "admin", verified: false });
      await addUser("disabled-admin@example.com", { role: "admin", disabled: true });
      await addUser("invited-admin@example.com", { role: "admin", status: "invited" });
      await addUser("member@example.com", { role: "member" });

      expect((await alertStore.listAdministratorEmails(workspaceId)).sort())
        .toEqual(["admin@example.com", "owner@example.com"]);
    });
  });

  describe("a skipped notice, end to end", () => {
    const sendThrough = async (options: {
      now: () => Date;
      sent: Array<{ to: string; kind: string; text: string }>;
      emails?: string[];
      capped?: boolean;
    }) => {
      const mailer = {
        send: async (message: { to: string; kind: string; text: string }) => { options.sent.push(message); return { dispatched: true }; },
      };
      const alerts = new UndeliveredRecipientAlerts({
        store: alertStore,
        mailer,
        identity: new NotificationRecipientIdentityRepository(database.kysely),
        dashboardUrl: async () => "https://app.example.com/w/acme/agents/front-desk",
        now: options.now,
      });
      const log = new NotificationDeliveryLog({ store: deliveries, alerts });
      const policy = new NotificationRecipientPolicyService({
        enabled: true,
        states,
        sendConfirmation: async () => ({ dispatched: false }),
        now: options.now,
      });
      const handler = new ContactSendActionHandler(
        mailer,
        { resolve: async () => ({ emails: options.emails ?? ["waiting@example.com"], webhook: null, agentId }) },
        undefined,
        undefined,
        undefined,
        options.capped ? { admit: async () => ({ dispatchAllowed: true, emailAllowed: false, reason: "workspace_daily_email_cap" as const }) } : undefined,
        policy,
        log,
      );
      const requestId = randomUUID();
      return handler.handle({
        payload: { message: "Please call me" },
        context: { requestId, workspaceId, accountId: null, conversationId, idempotencyKey: `key-${requestId}`, attempt: 1, skillName: null },
      }).catch((error: unknown) => error);
    };

    beforeEach(async () => {
      await database.query("DELETE FROM account_memberships");
      await database.query("DELETE FROM users");
      await database.query("UPDATE notification_recipient_confirmations SET undelivered_alert_sent_at = NULL");
      await addUser("owner@example.com", { role: "owner" });
      await addUser("admin@example.com", { role: "admin" });
      await addUser("unverified@example.com", { role: "admin", verified: false });
      await addUser("member@example.com", { role: "member" });
    });

    it("records the address, alerts the verified owners and admins once a day, and again the next", async () => {
      const sent: Array<{ to: string; kind: string; text: string }> = [];
      let current = new Date("2026-11-10T10:00:00.000Z");
      const now = () => current;

      const first = await sendThrough({ now, sent });
      expect(first).toMatchObject({ name: "ActionDispatchSkippedError", reason: "notification_recipient_unconfirmed" });
      expect(await rows()).toMatchObject([{ recipient_email: "waiting@example.com", outcome: "skipped_unconfirmed", kind: "contact_request", agent_id: agentId }]);
      const alertMails = () => sent.filter((message) => message.kind === "notification_alert");
      expect(alertMails().map((message) => message.to).sort()).toEqual(["admin@example.com", "owner@example.com"]);
      expect(alertMails()[0]?.text).toContain("waiting@example.com");
      expect(alertMails()[0]?.text).toContain("Front desk");

      current = new Date(current.getTime() + 60 * 60 * 1000);
      await sendThrough({ now, sent });
      expect(alertMails()).toHaveLength(2);
      expect(await rows()).toHaveLength(2);

      current = new Date(current.getTime() + UNDELIVERED_ALERT_WINDOW_MS);
      await sendThrough({ now, sent });
      expect(alertMails()).toHaveLength(4);
    });

    it("records a cap against a confirmed address and alerts nobody", async () => {
      const sent: Array<{ to: string; kind: string; text: string }> = [];

      // A verified member of the account is confirmed by membership; only the daily cap stops the mail.
      const outcome = await sendThrough({ now: () => new Date("2026-11-11T10:00:00.000Z"), sent, capped: true, emails: ["member@example.com"] });

      expect(outcome).toMatchObject({ name: "ActionDispatchSkippedError", reason: "workspace_daily_email_cap" });
      expect((await rows()).map((row) => [row.recipient_email, row.outcome])).toEqual([["member@example.com", "skipped_cap"]]);
      expect(sent).toEqual([]);
    });
  });
});
