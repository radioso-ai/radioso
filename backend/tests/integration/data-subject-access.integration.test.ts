import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createPostgresConversationErasureUnitOfWork,
  createWorkspaceConversationDataErasure,
} from "../../src/app/composition/conversationErasure.js";
import { createPostgresDataSubjectReadUnitOfWork } from "../../src/app/composition/dataSubjectAccess.js";
import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { AuditEventRepository } from "../../src/db/repositories/auditEventRepository.js";
import { PersonalCredentialLifecycleRepository } from "../../src/db/repositories/personalCredentialLifecycleRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { ConversationErasureService, DataSubjectAccessService } from "../../src/modules/privacy/public.js";
import type { DataSubjectIdentity } from "../../src/shared/domain/dataSubjectAccess.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

/** The address Jane writes from, which is also the customer id the host verifies her by on the website. */
const JANE = "jane@example.com";
const JANE_SLACK = "U0JANE";

interface Tenant {
  accountId: string;
  workspaceId: string;
  agentId: string;
  variableId: string;
  mailboxIds: string[];
  slackInstallationId: string;
  slackTeamId: string;
}

interface Subject {
  visitorId: string;
  webConversationId: string;
  emailConversationIds: string[];
  slackConversationId: string;
}

describeIntegration("data subject lookup, export and erasure (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const auditEvents = new AuditEventRepository(database.kysely);
  const erasure = new ConversationErasureService({
    unitOfWork: createPostgresConversationErasureUnitOfWork({ db: database.kysely, logger: { warn: vi.fn() } }),
    invalidation: { enqueue: vi.fn() },
    auditLog: {},
  });
  const access = new DataSubjectAccessService({
    reads: createPostgresDataSubjectReadUnitOfWork({ db: database.kysely }),
    erasure,
    audit: { record: async (event) => { await auditEvents.create(event); } },
  });
  const seededAccountIds: string[] = [];
  let tenant: Tenant;
  let otherTenant: Tenant;
  let jane: Subject;
  let john: Subject;

  const seedTenant = async (): Promise<Tenant> => {
    const account = await new AccountRepository(database.kysely).create({
      name: "Data Subject",
      email: `data-subject-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    seededAccountIds.push(account.id);
    const workspace = await new WorkspaceRepository(database.kysely).create(account.id, "Data Subject Workspace");
    const agentId = randomUUID();
    await database.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, 'Support')", [agentId, workspace.id]);
    const [variable] = await database.query<{ id: string }>(
      `INSERT INTO context_variables (workspace_id, name, value_type, trust_tier, sensitivity, default_surfacing)
       VALUES ($1, 'cart', 'json', 'unverified', 'normal', 'on_reference') RETURNING id`,
      [workspace.id],
    );
    const domainId = randomUUID();
    const domain = `mail-${randomUUID().slice(0, 8)}.example.com`;
    await database.query("INSERT INTO email_domains (id, workspace_id, domain, provider) VALUES ($1, $2, $3, 'local')", [domainId, workspace.id, domain]);
    const mailboxIds: string[] = [];
    for (const local of ["support", "sales"]) {
      const mailboxId = randomUUID();
      await database.query(
        `INSERT INTO email_mailboxes (id, workspace_id, domain_id, address, display_name, relay_token, engagement_mode)
         VALUES ($1, $2, $3, $4, 'Acme', $5, 'operator_only')`,
        [mailboxId, workspace.id, domainId, `${local}@${domain}`, randomUUID().replaceAll("-", "").slice(0, 26)],
      );
      mailboxIds.push(mailboxId);
    }
    const oauthConnectionId = randomUUID();
    await database.query(
      "INSERT INTO integration_oauth_connections (id, workspace_id, provider, display_name, status) VALUES ($1, $2, 'slack', 'Slack OAuth', 'authorized')",
      [oauthConnectionId, workspace.id],
    );
    const connectionId = randomUUID();
    await database.query(
      "INSERT INTO integration_connections (id, workspace_id, oauth_connection_id, provider, display_name, status) VALUES ($1, $2, $3, 'slack', 'Slack', 'authorized')",
      [connectionId, workspace.id, oauthConnectionId],
    );
    const slackInstallationId = randomUUID();
    const slackTeamId = `T${randomUUID().slice(0, 8).toUpperCase()}`;
    await database.query(
      "INSERT INTO slack_installations (id, connection_id, workspace_id, account_id, team_id, team_name, bot_user_id) VALUES ($1, $2, $3, $4, $5, 'Acme', 'UBOT')",
      [slackInstallationId, connectionId, workspace.id, account.id, slackTeamId],
    );
    return { accountId: account.id, workspaceId: workspace.id, agentId, variableId: variable.id, mailboxIds, slackInstallationId, slackTeamId };
  };

  const insertConversation = async (
    t: Tenant,
    input: { channel: string; visitorId?: string; verifiedCustomerId?: string; sessionId?: string; channelContext?: unknown; text: string },
  ): Promise<string> => {
    const conversationId = randomUUID();
    await database.query(
      `INSERT INTO conversations (id, workspace_id, agent_id, source_channel, visitor_id, verified_customer_id, anonymous_session_id, channel_context, title)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [conversationId, t.workspaceId, t.agentId, input.channel, input.visitorId ?? null, input.verifiedCustomerId ?? null,
        input.sessionId ?? null, input.channelContext ? JSON.stringify(input.channelContext) : null, input.text.slice(0, 20)],
    );
    if (input.visitorId) {
      await database.query("UPDATE visitors SET conversation_count = conversation_count + 1 WHERE id = $1", [input.visitorId]);
    }
    await database.query(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content, created_at) VALUES
         ($1, $3, $4, 'user', $5, now() - interval '1 minute'),
         ($2, $3, $4, 'assistant', 'Let me check that for you.', now())`,
      [randomUUID(), randomUUID(), conversationId, t.workspaceId, input.text],
    );
    return conversationId;
  };

  const insertEmailConversation = async (t: Tenant, mailboxId: string, address: string, text: string): Promise<string> => {
    const conversationId = await insertConversation(t, {
      channel: "email",
      channelContext: { provider: "email", mailbox: { id: mailboxId, address: "support@example.com" }, threadKey: randomUUID(), participant: { address } },
      text,
    });
    await database.query(
      `INSERT INTO email_thread_links (conversation_id, workspace_id, mailbox_id, thread_key, thread_token, participant_address, latest_subject)
       VALUES ($1, $2, $3, $4, $5, $6, 'Order 1182')`,
      [conversationId, t.workspaceId, mailboxId, randomUUID(), randomUUID().replaceAll("-", ""), address],
    );
    const [event] = await database.query<{ id: string }>(
      `INSERT INTO email_inbound_events (provider, provider_event_id, event_kind, envelope, state)
       VALUES ('local', $1, 'message_received', '{}'::jsonb, 'processed') RETURNING id`,
      [`evt-${randomUUID()}`],
    );
    const [delivery] = await database.query<{ id: string }>(
      `INSERT INTO email_inbound_deliveries (inbound_event_id, workspace_id, mailbox_id, state, sender_address, sender_display_name, subject, body_text, conversation_id)
       VALUES ($1, $2, $3, 'done', $4, 'Jane Doe', 'Order 1182', $5, $6) RETURNING id`,
      [event.id, t.workspaceId, mailboxId, address, text, conversationId],
    );
    await database.query(
      `INSERT INTO email_thread_messages (workspace_id, mailbox_id, conversation_id, direction, origin, rfc_message_id, subject, cc_addresses, inbound_delivery_id)
       VALUES ($1, $2, $3, 'inbound', 'inbound', $4, 'Order 1182', ARRAY['partner@example.com'], $5)`,
      [t.workspaceId, mailboxId, conversationId, `<${randomUUID()}@mail.example.com>`, delivery.id],
    );
    return conversationId;
  };

  const seedSubject = async (t: Tenant, who: { verifiedCustomerId: string; address: string; slackUserId: string }): Promise<Subject> => {
    const [visitor] = await database.query<{ id: string }>(
      `INSERT INTO visitors (workspace_id, visitor_key, verified_customer_id, conversation_count, last_country, last_language)
       VALUES ($1, $2, $3, 0, 'EE', 'et') RETURNING id`,
      [t.workspaceId, `visitor-key-${randomUUID()}`, who.verifiedCustomerId],
    );
    const sessionId = `session-${randomUUID()}`;
    const webConversationId = await insertConversation(t, {
      channel: "web",
      visitorId: visitor.id,
      verifiedCustomerId: who.verifiedCustomerId,
      sessionId,
      text: `I hurt my knee, can I still book? (${who.verifiedCustomerId})`,
    });
    await database.query(
      `INSERT INTO conversation_summaries (session_id, summary, covered_message_count, covered_through, expires_at)
       VALUES ($1, $2, 2, now(), now() + interval '1 day')`,
      [webConversationId, `Asked about booking with a knee injury (${who.verifiedCustomerId})`],
    );
    await database.query(
      "INSERT INTO routine_states (session_id, routine_id, variables, status) VALUES ($1, 'booking', $2::jsonb, 'completed')",
      [webConversationId, JSON.stringify({ injury: "knee", phone: "+372 5555 0000" })],
    );
    await database.query(
      `INSERT INTO routine_action_requests (type, payload, workspace_id, conversation_id, status)
       VALUES ('completion.notify', $1::jsonb, $2, $3, 'dispatched')`,
      [JSON.stringify({ conversationId: webConversationId, reason: "routine_completed", collected: { injury: "knee" } }), t.workspaceId, webConversationId],
    );
    await database.query(
      `INSERT INTO context_variable_values (workspace_id, variable_id, scope_type, scope_id, data) VALUES
         ($1, $2, 'session', $3, '{"items": ["yoga mat"]}'::jsonb),
         ($1, $2, 'customer', $4, '{"items": ["membership"]}'::jsonb)`,
      [t.workspaceId, t.variableId, sessionId, who.verifiedCustomerId],
    );
    const [assistantMessage] = await database.query<{ id: string }>(
      "SELECT id FROM messages WHERE conversation_id = $1 AND role = 'assistant'",
      [webConversationId],
    );
    await database.query(
      `INSERT INTO assistant_answer_feedback (id, workspace_id, conversation_id, assistant_message_id, anonymous_session_id, actor_type, actor_id, value, comment)
       VALUES ($5, $1, $2, $3, $4, 'anonymous_user', $4, 'down', 'Too slow')`,
      [t.workspaceId, webConversationId, assistantMessage.id, sessionId, randomUUID()],
    );
    const emailConversationIds = [
      await insertEmailConversation(t, t.mailboxIds[0], who.address, `Where is order 1182? (${who.address})`),
      await insertEmailConversation(t, t.mailboxIds[1], who.address, `Do you sell gift cards? (${who.address})`),
    ];
    const slackConversationId = await insertConversation(t, {
      channel: "slack",
      channelContext: {
        provider: "slack",
        team: { id: t.slackTeamId, name: "Acme" },
        channel: { id: "C0SUPPORT", type: "channel" },
        threadTs: "1760000000.000100",
        user: { id: who.slackUserId },
      },
      text: `Is the studio open on Sunday? (${who.slackUserId})`,
    });
    await database.query(
      "INSERT INTO slack_conversation_links (id, workspace_id, installation_id, slack_key, conversation_id) VALUES ($1, $2, $3, $4, $5)",
      [randomUUID(), t.workspaceId, t.slackInstallationId, `mention:${t.slackTeamId}:C0SUPPORT:${randomUUID()}`, slackConversationId],
    );
    return { visitorId: visitor.id, webConversationId, emailConversationIds, slackConversationId };
  };

  const confirmedWebAndEmail = (subject: Subject): DataSubjectIdentity[] => [
    { kind: "web_visitor", key: subject.visitorId },
    { kind: "email_address", key: JANE },
  ];

  const actor = (t: Tenant) => ({ accountId: t.accountId, userId: null });

  beforeAll(async () => {
    await runAllTestMigrations(database);
    tenant = await seedTenant();
    otherTenant = await seedTenant();
    jane = await seedSubject(tenant, { verifiedCustomerId: JANE, address: JANE, slackUserId: JANE_SLACK });
    john = await seedSubject(tenant, { verifiedCustomerId: "cust-john", address: "john@example.com", slackUserId: "U0JOHN" });
    // Jane is known to another workspace too; nothing of it may surface in this one.
    await seedSubject(otherTenant, { verifiedCustomerId: JANE, address: JANE, slackUserId: JANE_SLACK });
  });

  afterAll(async () => {
    const lifecycle = new PersonalCredentialLifecycleRepository(database.kysely, createWorkspaceConversationDataErasure());
    for (const accountId of seededAccountIds) {
      await lifecycle.deleteAccount({
        accountId,
        auditEvent: { accountId, eventType: "account.delete", eventStatus: "success", metadata: {} },
      });
    }
    await database.close().catch(() => undefined);
  });

  describe("lookup", () => {
    it("finds the web visitor and the email sender behind one address as two identities, merging neither", async () => {
      const candidates = await access.lookup({ workspaceId: tenant.workspaceId, query: `  ${JANE} `, actor: actor(tenant) });

      expect(candidates).toEqual([
        expect.objectContaining({ identity: { kind: "web_visitor", key: jane.visitorId }, channel: "web", label: JANE, conversationCount: 1 }),
        expect.objectContaining({ identity: { kind: "email_address", key: JANE }, channel: "email", label: JANE, conversationCount: 2 }),
      ]);
      expect(candidates[1].firstSeenAt).toBeInstanceOf(Date);
    });

    it("compares an address the way mail does and a verified customer id exactly as the host set it", async () => {
      const candidates = await access.lookup({ workspaceId: tenant.workspaceId, query: "Jane@Example.com", actor: actor(tenant) });

      expect(candidates.map((candidate) => candidate.identity)).toEqual([{ kind: "email_address", key: JANE }]);
    });

    it("finds a Slack user by their member id in every Slack workspace the workspace has installed", async () => {
      const candidates = await access.lookup({ workspaceId: tenant.workspaceId, query: JANE_SLACK, actor: actor(tenant) });

      expect(candidates).toEqual([
        expect.objectContaining({
          identity: { kind: "slack_user", key: `${tenant.slackTeamId}:${JANE_SLACK}` },
          channel: "slack",
          label: JANE_SLACK,
          conversationCount: 1,
        }),
      ]);
    });

    it("matches nothing partially", async () => {
      expect(await access.lookup({ workspaceId: tenant.workspaceId, query: "jane", actor: actor(tenant) })).toEqual([]);
      expect(await access.lookup({ workspaceId: tenant.workspaceId, query: "U0JAN", actor: actor(tenant) })).toEqual([]);
    });
  });

  describe("conversations", () => {
    it("lists the confirmed identities' conversations across channels, and only theirs", async () => {
      const conversations = await access.listConversations({ workspaceId: tenant.workspaceId, identities: confirmedWebAndEmail(jane) });

      expect(conversations.map((conversation) => conversation.id).sort()).toEqual([jane.webConversationId, ...jane.emailConversationIds].sort());
      expect(conversations.find((conversation) => conversation.id === jane.webConversationId)).toMatchObject({ channel: "web", messageCount: 2 });
    });

    it("reaches nothing through an identity of another workspace", async () => {
      const [otherVisitor] = await database.query<{ id: string }>(
        "SELECT id FROM visitors WHERE workspace_id = $1 AND verified_customer_id = $2",
        [otherTenant.workspaceId, JANE],
      );

      expect(await access.listConversations({
        workspaceId: tenant.workspaceId,
        identities: [{ kind: "web_visitor", key: otherVisitor.id }, { kind: "slack_user", key: `${otherTenant.slackTeamId}:${JANE_SLACK}` }],
      })).toEqual([]);
    });
  });

  describe("export", () => {
    it("exports everything held for the confirmed identities in one versioned document, and nothing of anyone else", async () => {
      const document = await access.export({
        workspaceId: tenant.workspaceId,
        identities: [...confirmedWebAndEmail(jane), { kind: "slack_user", key: `${tenant.slackTeamId}:${JANE_SLACK}` }],
        actor: actor(tenant),
      });

      expect(document).toMatchObject({ format: "radioso.data_subject_export", formatVersion: 1, workspaceId: tenant.workspaceId });
      const { sections } = document;
      expect(Object.keys(sections).sort()).toEqual([
        "answer_feedback",
        "context_values",
        "conversation_summaries",
        "conversations",
        "email_messages",
        "routine_actions",
        "routine_values",
        "visitors",
      ]);
      const conversationIds = sections.conversations.map((conversation) => conversation.id);
      expect([...conversationIds].sort()).toEqual([jane.webConversationId, ...jane.emailConversationIds, jane.slackConversationId].sort());
      const web = sections.conversations.find((conversation) => conversation.id === jane.webConversationId);
      expect(web).toMatchObject({
        channel: "web",
        messages: [
          expect.objectContaining({ role: "user", content: `I hurt my knee, can I still book? (${JANE})` }),
          expect.objectContaining({ role: "assistant", content: "Let me check that for you." }),
        ],
      });
      expect(sections.visitors).toEqual([expect.objectContaining({ id: jane.visitorId, verifiedCustomerId: JANE, lastCountry: "EE" })]);
      expect(sections.routine_values).toEqual([
        expect.objectContaining({ conversationId: jane.webConversationId, routineId: "booking", status: "completed", values: { injury: "knee", phone: "+372 5555 0000" } }),
      ]);
      expect(sections.routine_actions).toEqual([
        expect.objectContaining({ conversationId: jane.webConversationId, type: "completion.notify", payload: expect.objectContaining({ collected: { injury: "knee" } }) }),
      ]);
      expect(sections.conversation_summaries).toEqual([
        expect.objectContaining({ conversationId: jane.webConversationId, summary: `Asked about booking with a knee injury (${JANE})` }),
      ]);
      expect(sections.context_values).toEqual(expect.arrayContaining([
        expect.objectContaining({ variable: "cart", scope: "session", value: { items: ["yoga mat"] } }),
        expect.objectContaining({ variable: "cart", scope: "customer", value: { items: ["membership"] } }),
      ]));
      expect(sections.context_values).toHaveLength(2);
      expect(sections.answer_feedback).toEqual([
        expect.objectContaining({ conversationId: jane.webConversationId, value: "down", comment: "Too slow" }),
      ]);
      expect(sections.email_messages).toHaveLength(2);
      expect(sections.email_messages[0]).toMatchObject({
        direction: "inbound",
        subject: "Order 1182",
        senderAddress: JANE,
        senderDisplayName: "Jane Doe",
        ccAddresses: ["partner@example.com"],
      });
      const exported = JSON.stringify(document);
      expect(exported).not.toContain("john@example.com");
      expect(exported).not.toContain("cust-john");
      expect(exported).not.toContain("U0JOHN");
    });

    it("records the lookup and the export with ids and counts, never the address or anything said", async () => {
      await access.lookup({ workspaceId: tenant.workspaceId, query: JANE, actor: actor(tenant) });
      await access.export({ workspaceId: tenant.workspaceId, identities: confirmedWebAndEmail(jane), actor: actor(tenant) });

      const rows = await database.query<{ event_type: string; metadata_json: Record<string, unknown> }>(
        "SELECT event_type, metadata_json FROM audit_events WHERE workspace_id = $1 AND event_type LIKE 'data_subject.%' ORDER BY created_at",
        [tenant.workspaceId],
      );
      expect(rows.map((row) => row.event_type)).toEqual(expect.arrayContaining(["data_subject.looked_up", "data_subject.exported"]));
      const exported = rows.filter((row) => row.event_type === "data_subject.exported").at(-1)!;
      expect(exported.metadata_json).toMatchObject({
        conversationCount: 3,
        recordsBySection: expect.objectContaining({ conversations: 3, visitors: 1, email_messages: 2 }),
        identities: [{ kind: "web_visitor", ref: jane.visitorId }, { kind: "email_address", ref: expect.stringMatching(/^sha256:/) }],
      });
      for (const row of rows) {
        const recorded = JSON.stringify(row.metadata_json);
        expect(recorded).not.toContain(JANE);
        expect(recorded).not.toContain("knee");
      }
    });
  });

  describe("erasure", () => {
    it("erases what the confirmed identities reach and leaves every other identity's data", async () => {
      const receipt = await access.erase({ workspaceId: tenant.workspaceId, identities: confirmedWebAndEmail(jane), actor: actor(tenant) });

      expect(receipt).toEqual({ visitorCount: 1, conversationCount: 3, messageCount: 6 });
      const remaining = await database.query<{ id: string }>("SELECT id FROM conversations WHERE workspace_id = $1", [tenant.workspaceId]);
      const remainingIds = remaining.map((row) => row.id);
      expect(remainingIds).not.toEqual(expect.arrayContaining([jane.webConversationId]));
      for (const id of jane.emailConversationIds) expect(remainingIds).not.toContain(id);
      // Jane's Slack identity was not confirmed, so its conversation stays, as do John's.
      expect(remainingIds).toEqual(expect.arrayContaining([jane.slackConversationId, john.webConversationId, ...john.emailConversationIds]));
      expect(await database.query("SELECT id FROM visitors WHERE id = $1", [jane.visitorId])).toEqual([]);
      expect(await database.query(
        "SELECT id FROM context_variable_values WHERE workspace_id = $1 AND scope_type = 'customer' AND scope_id = $2",
        [tenant.workspaceId, JANE],
      )).toEqual([]);
      expect(await access.lookup({ workspaceId: tenant.workspaceId, query: JANE, actor: actor(tenant) })).toEqual([]);
      expect(await access.lookup({ workspaceId: otherTenant.workspaceId, query: JANE, actor: actor(otherTenant) })).toHaveLength(2);
    });
  });
});
