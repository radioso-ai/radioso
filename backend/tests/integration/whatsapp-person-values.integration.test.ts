import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createPostgresConversationErasureUnitOfWork,
  createWorkspaceConversationDataErasure,
} from "../../src/app/composition/conversationErasure.js";
import { conversationReadSources } from "../../src/app/composition/conversationReadSources.js";
import { createConversationRetentionSweep } from "../../src/app/composition/conversationRetention.js";
import { createPostgresDataSubjectReadUnitOfWork } from "../../src/app/composition/dataSubjectAccess.js";
import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { AuditEventRepository } from "../../src/db/repositories/auditEventRepository.js";
import { ContextValueConsentWithholder } from "../../src/db/repositories/contextValueConsentWithholder.js";
import { ContextVariableRepository } from "../../src/db/repositories/contextVariableRepository.js";
import { ConversationAttributeReads } from "../../src/db/repositories/conversationAttributeReads.js";
import { PersonalCredentialLifecycleRepository } from "../../src/db/repositories/personalCredentialLifecycleRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { AuditService } from "../../src/modules/audit/services/auditService.js";
import { PostgresWhatsAppPersistence } from "../../src/modules/connectors/plugins/whatsapp/whatsappPersistence.js";
import { ConversationAttributeService, routineValueWriter } from "../../src/modules/context-variables/public.js";
import { ConversationErasureService, DataSubjectAccessService } from "../../src/modules/privacy/public.js";
import { Database } from "../../src/shared/infra/database.js";
import { createLogger } from "../../src/shared/observability/logger.js";
import { MetricsRegistry } from "../../src/shared/observability/metrics/metricsRegistry.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

// Obviously fake numbers in the reserved 555-01xx range, in the form Meta reports `wa_id`.
const NUMBER_A = "15550100101";
const NUMBER_B = "15550100102";

interface Tenant {
  accountId: string;
  workspaceId: string;
  agentId: string;
  variableId: string;
  variableName: string;
}

/**
 * A WhatsApp number as a person key (#1884): what is kept under a number is read on that number's
 * conversations only, and goes when its latest conversation is erased, by a teammate, by retention
 * or by a data subject's request, or when the routine run that saved it loses its consent.
 */
describeIntegration("a WhatsApp number's person values (Postgres, #1884)", () => {
  const database = new Database(integrationDatabaseUrl);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const values = new ContextVariableRepository(database.kysely, null);
  const whatsapp = new PostgresWhatsAppPersistence(database.kysely);
  const attributes = new ConversationAttributeService(new ConversationAttributeReads(database.kysely, conversationReadSources(database.kysely)));
  const auditEvents = new AuditEventRepository(database.kysely);
  const erasure = new ConversationErasureService({
    unitOfWork: createPostgresConversationErasureUnitOfWork({ db: database.kysely, logger }),
    invalidation: { enqueue: vi.fn() },
    auditLog: {},
  });
  const access = new DataSubjectAccessService({
    reads: createPostgresDataSubjectReadUnitOfWork({ db: database.kysely }),
    erasure,
    audit: { record: async (event) => { await auditEvents.create(event); } },
  });
  const seededAccountIds: string[] = [];
  const api = { kind: "api" as const, ref: "credential-1" };

  beforeAll(async () => {
    await runAllTestMigrations(database);
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

  const seedTenant = async (): Promise<Tenant> => {
    const account = await new AccountRepository(database.kysely).create({
      name: "WhatsApp Persons",
      email: `whatsapp-persons-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    seededAccountIds.push(account.id);
    const workspace = await new WorkspaceRepository(database.kysely).create(account.id, "WhatsApp Persons Workspace");
    const agentId = randomUUID();
    await database.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, 'Front desk')", [agentId, workspace.id]);
    const variableName = `loyalty_tier_${randomUUID().slice(0, 8)}`;
    const variable = await values.create({
      workspaceId: workspace.id, name: variableName, valueType: "string", trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "always",
    });
    return { accountId: account.id, workspaceId: workspace.id, agentId, variableId: variable.id, variableName };
  };

  /** A conversation `idleDays` old, on WhatsApp with `number` when one is given, as the channel records it after answering. */
  const startConversation = async (tenant: Tenant, number: string | null, idleDays = 0): Promise<string> => {
    const conversationId = randomUUID();
    await database.query(
      `INSERT INTO conversations (id, workspace_id, agent_id, source_channel, created_at, updated_at)
       VALUES ($1, $2, $3, $4, now() - make_interval(days => $5), now() - make_interval(days => $5))`,
      [conversationId, tenant.workspaceId, tenant.agentId, number ? "whatsapp" : "website_embed", idleDays],
    );
    if (number) {
      await whatsapp.upsertContact({ workspaceId: tenant.workspaceId, waId: number, profileName: "Ada", conversationId, lastMessageAt: new Date() });
      await whatsapp.createMessageLog({
        wamid: `wamid.${randomUUID()}`, direction: "inbound", workspaceId: tenant.workspaceId, waId: number,
        messageType: "text", payload: { text: { body: "Is there a table for four?" } }, status: "replied",
      });
    }
    return conversationId;
  };

  const keepForNumber = (tenant: Tenant, number: string, data: string, writtenBy: { kind: "api" | "routine"; ref: string } = api) =>
    values.upsertValue(tenant.variableId, { type: "whatsapp_contact", id: number }, data, writtenBy);

  const attributeOn = async (tenant: Tenant, conversationId: string) =>
    (await attributes.read(tenant.workspaceId, { conversationId, chatSessionId: null, verifiedCustomerId: null }))
      .map(({ name, value, scope }) => ({ name, value, scope }));

  const personValues = async (tenant: Tenant) => (await database.query<{ scope_id: string; data: unknown }>(
    "SELECT scope_id, data FROM context_variable_values WHERE workspace_id = $1 AND scope_type = 'whatsapp_contact' ORDER BY scope_id",
    [tenant.workspaceId],
  )).map((row) => ({ number: row.scope_id, data: row.data }));

  const loggedNumbers = async (tenant: Tenant) => (await database.query<{ wa_id: string }>(
    "SELECT DISTINCT wa_id FROM connector_whatsapp_message_log WHERE workspace_id = $1 ORDER BY wa_id",
    [tenant.workspaceId],
  )).map((row) => row.wa_id);

  const actor = (tenant: Tenant) => ({ accountId: tenant.accountId, userId: null });

  describe("reading", () => {
    it("reads a number's value on each of its conversations, never on another number's or a web conversation", async () => {
      const tenant = await seedTenant();
      const earlier = await startConversation(tenant, NUMBER_A, 3);
      const latest = await startConversation(tenant, NUMBER_A);
      const otherNumber = await startConversation(tenant, NUMBER_B);
      const web = await startConversation(tenant, null);
      await keepForNumber(tenant, NUMBER_A, "gold");

      const forNumber = [{ name: tenant.variableName, value: "gold", scope: "whatsapp_contact" }];
      expect(await attributeOn(tenant, earlier)).toEqual(forNumber);
      expect(await attributeOn(tenant, latest)).toEqual(forNumber);
      expect(await attributeOn(tenant, otherNumber)).toEqual([]);
      expect(await attributeOn(tenant, web)).toEqual([]);
    });
  });

  describe("erasing a conversation", () => {
    it("keeps a number's values and log while an earlier conversation goes, and takes them with its latest", async () => {
      const tenant = await seedTenant();
      const earlier = await startConversation(tenant, NUMBER_A, 3);
      const latest = await startConversation(tenant, NUMBER_A);
      await startConversation(tenant, NUMBER_B);
      await keepForNumber(tenant, NUMBER_A, "gold");
      await keepForNumber(tenant, NUMBER_B, "silver");

      await erasure.eraseConversation({ workspaceId: tenant.workspaceId, conversationId: earlier, actor: actor(tenant) });

      expect(await personValues(tenant)).toEqual([{ number: NUMBER_A, data: "gold" }, { number: NUMBER_B, data: "silver" }]);
      expect(await loggedNumbers(tenant)).toEqual([NUMBER_A, NUMBER_B]);

      await erasure.eraseConversation({ workspaceId: tenant.workspaceId, conversationId: latest, actor: actor(tenant) });

      expect(await personValues(tenant)).toEqual([{ number: NUMBER_B, data: "silver" }]);
      expect(await loggedNumbers(tenant)).toEqual([NUMBER_B]);
    });

    it("takes a number's values when retention ages out its latest conversation, and keeps a number whose latest is inside the window", async () => {
      const tenant = await seedTenant();
      await database.query("UPDATE workspaces SET conversation_retention_days = NULL WHERE conversation_retention_days IS NOT NULL");
      await database.query("UPDATE workspaces SET conversation_retention_days = 30 WHERE id = $1", [tenant.workspaceId]);
      await startConversation(tenant, NUMBER_A, 60);
      await startConversation(tenant, NUMBER_B, 60);
      await startConversation(tenant, NUMBER_B, 1);
      await keepForNumber(tenant, NUMBER_A, "gold");
      await keepForNumber(tenant, NUMBER_B, "silver");

      await createConversationRetentionSweep({
        db: database.kysely,
        erasure,
        audit: new AuditService(createLogger("silent"), auditEvents),
        logger,
        metrics: new MetricsRegistry(),
      }).run();

      expect(await personValues(tenant)).toEqual([{ number: NUMBER_B, data: "silver" }]);
      expect(await loggedNumbers(tenant)).toEqual([NUMBER_B]);
      await database.query("UPDATE workspaces SET conversation_retention_days = NULL WHERE id = $1", [tenant.workspaceId]);
    });
  });

  describe("a data subject by number", () => {
    it("finds a number however it is written, exports what is kept for it, and erases it, leaving another number's", async () => {
      const tenant = await seedTenant();
      const earlier = await startConversation(tenant, NUMBER_A, 3);
      const latest = await startConversation(tenant, NUMBER_A);
      const otherNumber = await startConversation(tenant, NUMBER_B);
      await keepForNumber(tenant, NUMBER_A, "gold");
      await keepForNumber(tenant, NUMBER_B, "silver");

      const candidates = await access.lookup({ workspaceId: tenant.workspaceId, query: " +1 (555) 010-0101 ", actor: actor(tenant) });

      expect(candidates).toEqual([expect.objectContaining({
        identity: { kind: "whatsapp_number", key: NUMBER_A }, channel: "whatsapp", label: `+${NUMBER_A}`, conversationCount: 2,
      })]);
      const identities = [{ kind: "whatsapp_number" as const, key: NUMBER_A }];

      const document = await access.export({ workspaceId: tenant.workspaceId, identities, actor: actor(tenant) });

      expect(document.sections.conversations.map((conversation) => conversation.id).sort()).toEqual([earlier, latest].sort());
      expect(document.sections.whatsapp_contacts).toEqual([expect.objectContaining({ number: `+${NUMBER_A}`, latestConversationId: latest })]);
      expect(document.sections.whatsapp_messages).toEqual([
        expect.objectContaining({ number: `+${NUMBER_A}`, direction: "inbound" }),
        expect.objectContaining({ number: `+${NUMBER_A}`, direction: "inbound" }),
      ]);
      expect(document.sections.context_values).toEqual([expect.objectContaining({ scope: "whatsapp_contact", value: "gold" })]);
      expect(JSON.stringify(document)).not.toContain(NUMBER_B);

      await access.erase({ workspaceId: tenant.workspaceId, identities, actor: actor(tenant) });

      expect(await personValues(tenant)).toEqual([{ number: NUMBER_B, data: "silver" }]);
      expect(await loggedNumbers(tenant)).toEqual([NUMBER_B]);
      expect(await access.lookup({ workspaceId: tenant.workspaceId, query: NUMBER_A, actor: actor(tenant) })).toEqual([]);
      expect(await attributeOn(tenant, otherNumber)).toEqual([{ name: tenant.variableName, value: "silver", scope: "whatsapp_contact" }]);
      const audits = await database.query<{ metadata_json: unknown }>(
        "SELECT metadata_json FROM audit_events WHERE workspace_id = $1 AND event_type LIKE 'data_subject.%'",
        [tenant.workspaceId],
      );
      expect(audits.length).toBeGreaterThan(0);
      expect(JSON.stringify(audits)).not.toContain(NUMBER_A.slice(-7));
    });
  });

  describe("a withdrawn consent", () => {
    it("takes the number's values the routine's run saved in this conversation, and keeps another conversation's run", async () => {
      const tenant = await seedTenant();
      const earlier = await startConversation(tenant, NUMBER_A, 3);
      const latest = await startConversation(tenant, NUMBER_A);
      const fieldOf = async (name: string) => (await values.create({
        workspaceId: tenant.workspaceId, name: `${name}_${randomUUID().slice(0, 8)}`, valueType: "string",
        trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "always",
      })).id;
      const emailId = await fieldOf("contact_email");
      await values.upsertValue(tenant.variableId, { type: "whatsapp_contact", id: NUMBER_A }, "gold", routineValueWriter("booking", randomUUID(), earlier));
      await values.upsertValue(emailId, { type: "whatsapp_contact", id: NUMBER_A }, "ada@guests.example", routineValueWriter("booking", randomUUID(), latest));

      await new ContextValueConsentWithholder(database.kysely).withhold({
        workspaceId: tenant.workspaceId,
        conversationId: latest,
        messageIds: [],
        valueTexts: [],
        withdrawnRoutineSlots: [{ routineId: "booking", slotKeys: ["email"] }],
      });

      expect(await personValues(tenant)).toEqual([{ number: NUMBER_A, data: "gold" }]);
    });
  });
});
