import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { createWorkspaceConversationDataErasure } from "../../src/app/composition/conversationErasure.js";
import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { PersonalCredentialLifecycleRepository } from "../../src/db/repositories/personalCredentialLifecycleRepository.js";
import {
  ConsentRecordExporter,
  ConsentRecordRetention,
  ConsentWordingVersionRetention,
  RoutineConsentRepository,
} from "../../src/db/repositories/routineConsentRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { routineConsentWordingVersionId, type RoutineConsentWording } from "../../src/shared/domain/routineConsentWording.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

interface Tenant {
  accountId: string;
  workspaceId: string;
  agentId: string;
}

interface SeededConversation {
  conversationId: string;
  visitorId: string;
  userMessageId: string;
}

const english: RoutineConsentWording = {
  locale: "en",
  body: "We ask about your health to book the right session. Your answer stays with this booking.",
  agreeLabel: "I agree",
  declineLabel: "No thanks",
};
const german: RoutineConsentWording = {
  locale: "de",
  body: "Wir fragen nach Ihrer Gesundheit, um die passende Sitzung zu buchen.",
  agreeLabel: "Ich stimme zu",
  declineLabel: "Nein danke",
};

describeIntegration("routine consent records (Postgres, #1544)", () => {
  const database = new Database(integrationDatabaseUrl);
  const seededAccountIds: string[] = [];

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

  const seedTenant = async (retentionDays: number | null = null): Promise<Tenant> => {
    const account = await new AccountRepository(database.kysely).create({
      name: "Consent",
      email: `consent-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    seededAccountIds.push(account.id);
    const workspace = await new WorkspaceRepository(database.kysely).create(account.id, "Consent Workspace");
    await database.query("UPDATE workspaces SET conversation_retention_days = $2 WHERE id = $1", [workspace.id, retentionDays]);
    const agentId = randomUUID();
    await database.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, 'Bookings')", [agentId, workspace.id]);
    return { accountId: account.id, workspaceId: workspace.id, agentId };
  };

  const seedConversation = async (tenant: Tenant): Promise<SeededConversation> => {
    const [visitor] = await database.query<{ id: string }>(
      "INSERT INTO visitors (workspace_id, visitor_key, conversation_count) VALUES ($1, $2, 1) RETURNING id",
      [tenant.workspaceId, `visitor-key-${randomUUID()}`],
    );
    const conversationId = randomUUID();
    const userMessageId = randomUUID();
    await database.query(
      "INSERT INTO conversations (id, workspace_id, agent_id, visitor_id) VALUES ($1, $2, $3, $4)",
      [conversationId, tenant.workspaceId, tenant.agentId, visitor.id],
    );
    await database.query(
      "INSERT INTO messages (id, conversation_id, workspace_id, role, content) VALUES ($1, $2, $3, 'user', 'Yes, go ahead')",
      [userMessageId, conversationId, tenant.workspaceId],
    );
    return { conversationId, visitorId: visitor.id, userMessageId };
  };

  const recordDecision = async (
    tenant: Tenant,
    conversation: SeededConversation,
    overrides: Partial<Parameters<RoutineConsentRepository["insertRecord"]>[0]> & { wording?: RoutineConsentWording } = {},
  ) => {
    const { wording = english, ...record } = overrides;
    const repository = new RoutineConsentRepository(database.kysely);
    const wordingVersionId = await repository.upsertWordingVersion({ workspaceId: tenant.workspaceId, wording });
    return repository.insertRecord({
      workspaceId: tenant.workspaceId,
      agentId: tenant.agentId,
      conversationId: conversation.conversationId,
      visitorId: conversation.visitorId,
      routineId: "routine-intake",
      consentKey: "health",
      slotKeys: ["pregnant"],
      wordingVersionId,
      locale: wording.locale,
      decision: "granted",
      method: "reply",
      defaulted: false,
      channel: "web",
      decisionMessageId: conversation.userMessageId,
      ...record,
    });
  };

  const recordsOf = (conversationId: string) => database.query<{
    decision: string;
    decision_message_id: string | null;
    conversation_id: string | null;
    visitor_id: string | null;
  }>(
    "SELECT decision, decision_message_id, conversation_id, visitor_id FROM routine_consent_records WHERE conversation_id = $1",
    [conversationId],
  );

  it("keeps every wording shown once and unchanged, under the hash of its content", async () => {
    const tenant = await seedTenant();
    const repository = new RoutineConsentRepository(database.kysely);

    const first = await repository.upsertWordingVersion({ workspaceId: tenant.workspaceId, wording: english });
    const again = await repository.upsertWordingVersion({ workspaceId: tenant.workspaceId, wording: { ...english } });
    const other = await repository.upsertWordingVersion({ workspaceId: tenant.workspaceId, wording: german });

    expect(again).toBe(first);
    expect(other).not.toBe(first);
    const stored = await database.query<{ id: string; locale: string; body: string; agree_label: string; decline_label: string }>(
      "SELECT id, locale, body, agree_label, decline_label FROM routine_consent_wording_versions WHERE workspace_id = $1 ORDER BY locale",
      [tenant.workspaceId],
    );
    expect(stored).toHaveLength(2);
    for (const row of stored) {
      expect(row.id).toBe(routineConsentWordingVersionId({ locale: row.locale, body: row.body, agreeLabel: row.agree_label, declineLabel: row.decline_label }));
    }
  });

  it("records a decision once, however often a turn retries it", async () => {
    const tenant = await seedTenant();
    const conversation = await seedConversation(tenant);

    expect(await recordDecision(tenant, conversation)).toBe(true);
    expect(await recordDecision(tenant, conversation, { decision: "declined" })).toBe(false);

    expect(await recordsOf(conversation.conversationId)).toEqual([{
      decision: "granted",
      decision_message_id: conversation.userMessageId,
      conversation_id: conversation.conversationId,
      visitor_id: conversation.visitorId,
    }]);
  });

  it("reads what a conversation decided for a consent, for any of its wordings", async () => {
    const tenant = await seedTenant();
    const repository = new RoutineConsentRepository(database.kysely);
    const granted = await seedConversation(tenant);
    const declined = await seedConversation(tenant);
    const withdrawn = await seedConversation(tenant);
    const undecided = await seedConversation(tenant);
    const englishId = routineConsentWordingVersionId(english);
    const germanId = routineConsentWordingVersionId(german);
    await recordDecision(tenant, granted, { wording: german });
    await recordDecision(tenant, declined, { decision: "declined", method: "button" });
    await recordDecision(tenant, withdrawn);
    await database.query(
      "UPDATE routine_consent_records SET withdrawn_at = now(), withdrawn_by_account_id = $2 WHERE conversation_id = $1",
      [withdrawn.conversationId, tenant.accountId],
    );
    const standing = (conversation: SeededConversation, overrides: { routineId?: string; consentKey?: string; versionIds?: string[] } = {}) =>
      repository.standing({
        conversationId: conversation.conversationId,
        routineId: overrides.routineId ?? "routine-intake",
        consentKey: overrides.consentKey ?? "health",
        versionIds: overrides.versionIds ?? [englishId, germanId],
      });

    expect(await standing(granted)).toBe("granted");
    expect(await standing(declined)).toBe("declined");
    expect(await standing(withdrawn)).toBe("declined");
    expect(await standing(undecided)).toBeNull();
    // A decision on wording the routine no longer carries, or for another routine or consent, is not this one's.
    expect(await standing(granted, { versionIds: [englishId] })).toBeNull();
    expect(await standing(granted, { routineId: "routine-other" })).toBeNull();
    expect(await standing(granted, { consentKey: "allergies" })).toBeNull();
    expect(await standing(granted, { versionIds: [] })).toBeNull();
  });

  it("finds the consent prompt a conversation showed last, for the routine and consent asked", async () => {
    const tenant = await seedTenant();
    const repository = new RoutineConsentRepository(database.kysely);
    const conversation = await seedConversation(tenant);
    const prompt = (consentKey: string, wordingVersionId: string, locale: string) =>
      JSON.stringify({ consentPrompt: { routineId: "routine-intake", consentKey, wordingVersionId, locale } });
    const [older, newer, otherConsent] = [randomUUID(), randomUUID(), randomUUID()];
    await database.query(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content, metadata_json, created_at) VALUES
         ($1, $4, $5, 'assistant', 'English wording', $6::jsonb, now() - interval '2 minutes'),
         ($2, $4, $5, 'assistant', 'German wording', $7::jsonb, now() - interval '1 minute'),
         ($3, $4, $5, 'assistant', 'Other wording', $8::jsonb, now())`,
      [older, newer, otherConsent, conversation.conversationId, tenant.workspaceId,
        prompt("health", "version-en", "en"), prompt("health", "version-de", "de"), prompt("allergies", "version-en", "en")],
    );

    expect(await repository.latestPrompt({ conversationId: conversation.conversationId, routineId: "routine-intake", consentKey: "health" }))
      .toEqual({ messageId: newer, wordingVersionId: "version-de", locale: "de" });
    expect(await repository.latestPrompt({ conversationId: conversation.conversationId, routineId: "routine-other", consentKey: "health" }))
      .toBeNull();
    expect(await repository.latestPrompt({ conversationId: randomUUID(), routineId: "routine-intake", consentKey: "health" }))
      .toBeNull();
  });

  it("keeps the record when its message goes, and drops only the link to it", async () => {
    const tenant = await seedTenant();
    const conversation = await seedConversation(tenant);
    await recordDecision(tenant, conversation);

    await database.kysely.deleteFrom("conversations").where("id", "=", conversation.conversationId).execute();

    expect(await recordsOf(conversation.conversationId)).toEqual([{
      decision: "granted",
      decision_message_id: null,
      conversation_id: conversation.conversationId,
      visitor_id: conversation.visitorId,
    }]);
  });

  it("exports a data subject's records with the wording they were shown, by conversation or by visitor", async () => {
    const tenant = await seedTenant();
    const other = await seedTenant();
    const byConversation = await seedConversation(tenant);
    const byVisitor = await seedConversation(tenant);
    const unrelated = await seedConversation(tenant);
    const foreign = await seedConversation(other);
    await recordDecision(tenant, byConversation, { wording: german, method: "button" });
    await recordDecision(tenant, byVisitor, { decision: "declined", defaulted: true, channel: "email" });
    await recordDecision(tenant, unrelated);
    await recordDecision(other, foreign);

    const exported = await new ConsentRecordExporter(database.kysely).export({
      workspaceId: tenant.workspaceId,
      conversationIds: [byConversation.conversationId, foreign.conversationId],
      visitorIds: [byVisitor.visitorId],
      verifiedCustomerIds: [],
    });

    expect(exported).toEqual([
      {
        id: expect.any(String),
        conversationId: byConversation.conversationId,
        routineId: "routine-intake",
        consentKey: "health",
        decision: "granted",
        method: "button",
        defaulted: false,
        channel: "web",
        locale: "de",
        wordingVersionId: routineConsentWordingVersionId(german),
        wording: { body: german.body, agreeLabel: german.agreeLabel, declineLabel: german.declineLabel },
        decidedAt: expect.any(String),
        withdrawnAt: null,
      },
      expect.objectContaining({
        conversationId: byVisitor.conversationId,
        decision: "declined",
        defaulted: true,
        channel: "email",
        wording: { body: english.body, agreeLabel: english.agreeLabel, declineLabel: english.declineLabel },
      }),
    ]);
    expect(await new ConsentRecordExporter(database.kysely).export({
      workspaceId: tenant.workspaceId,
      conversationIds: [],
      visitorIds: [],
      verifiedCustomerIds: [],
    })).toEqual([]);
  });

  it("removes records and unreferenced wordings past the workspace's own window, and nothing else", async () => {
    const kept = await seedTenant(null);
    const windowed = await seedTenant(30);
    const keptConversation = await seedConversation(kept);
    const oldConversation = await seedConversation(windowed);
    const recentConversation = await seedConversation(windowed);
    await recordDecision(kept, keptConversation);
    await recordDecision(windowed, oldConversation);
    await recordDecision(windowed, recentConversation, { wording: german });
    // A wording shown long ago that nobody decided on, and one shown just now.
    const repository = new RoutineConsentRepository(database.kysely);
    const unanswered = { ...english, body: "Older wording nobody answered." };
    const fresh = { ...english, body: "Wording shown just now." };
    await repository.upsertWordingVersion({ workspaceId: windowed.workspaceId, wording: unanswered });
    await repository.upsertWordingVersion({ workspaceId: windowed.workspaceId, wording: fresh });
    await repository.upsertWordingVersion({ workspaceId: kept.workspaceId, wording: unanswered });
    for (const workspaceId of [kept.workspaceId, windowed.workspaceId]) {
      await database.query(
        "UPDATE routine_consent_wording_versions SET first_shown_at = now() - interval '40 days' WHERE workspace_id = $1 AND id <> $2",
        [workspaceId, routineConsentWordingVersionId(fresh)],
      );
    }
    await database.query(
      "UPDATE routine_consent_records SET decided_at = now() - interval '40 days' WHERE conversation_id = ANY($1::uuid[])",
      [[keptConversation.conversationId, oldConversation.conversationId]],
    );
    await database.query(
      "UPDATE routine_consent_records SET decided_at = now() - interval '10 days' WHERE conversation_id = $1",
      [recentConversation.conversationId],
    );
    const now = new Date();
    const records = new ConsentRecordRetention(database.kysely);
    const versions = new ConsentWordingVersionRetention(database.kysely);

    expect(await records.enforce({ now, limit: 1 })).toBe(1);
    expect(await records.enforce({ now, limit: 10 })).toBe(0);
    // The old English wording lost its only record above; the German one is still named by a record.
    expect(await versions.enforce({ now, limit: 10 })).toBe(2);

    expect(await recordsOf(oldConversation.conversationId)).toEqual([]);
    expect(await recordsOf(recentConversation.conversationId)).toHaveLength(1);
    expect(await recordsOf(keptConversation.conversationId)).toHaveLength(1);
    const remaining = await database.query<{ workspace_id: string; body: string }>(
      "SELECT workspace_id, body FROM routine_consent_wording_versions WHERE workspace_id = ANY($1::uuid[]) ORDER BY workspace_id, body",
      [[kept.workspaceId, windowed.workspaceId]],
    );
    expect(remaining).toEqual(expect.arrayContaining([
      { workspace_id: kept.workspaceId, body: english.body },
      { workspace_id: kept.workspaceId, body: unanswered.body },
      { workspace_id: windowed.workspaceId, body: german.body },
      { workspace_id: windowed.workspaceId, body: fresh.body },
    ]));
    expect(remaining).toHaveLength(4);
  });

  it("goes with its workspace", async () => {
    const tenant = await seedTenant();
    const conversation = await seedConversation(tenant);
    await recordDecision(tenant, conversation);

    const deleted = await new PersonalCredentialLifecycleRepository(database.kysely, createWorkspaceConversationDataErasure()).deleteWorkspace({
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      auditEvent: { accountId: tenant.accountId, eventType: "workspace.delete", eventStatus: "success", metadata: {} },
    });

    expect(deleted).toBe(true);
    expect(await recordsOf(conversation.conversationId)).toEqual([]);
    const versions = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM routine_consent_wording_versions WHERE workspace_id = $1",
      [tenant.workspaceId],
    );
    expect(versions[0]?.count).toBe("0");
  });
});
