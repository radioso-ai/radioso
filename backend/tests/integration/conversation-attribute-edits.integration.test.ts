import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { buildConversationAttributeEdits } from "../../src/app/composition/conversationAttributeEdits.js";
import { AgentRevisionRuntimeRepository } from "../../src/db/repositories/agentRevisionRuntimeRepository.js";
import { BackgroundJobRepository } from "../../src/db/repositories/backgroundJobRepository.js";
import { ClassifiedContextVariableReads } from "../../src/db/repositories/classifiedContextVariableReads.js";
import { ContextVariableRepository } from "../../src/db/repositories/contextVariableRepository.js";
import { postgresWorkspaceEventRecorder } from "../../src/db/repositories/workspaceEventLogRepository.js";
import { ConversationValueWriterService, type ContextVariableOption } from "../../src/modules/context-variables/public.js";
import { ConversationClassificationService } from "../../src/modules/contextClassification/public.js";
import { DefaultBackgroundJobQueue, NoopBackgroundJobWake } from "../../src/shared/background-jobs/backgroundJobQueue.js";
import { Database } from "../../src/shared/infra/database.js";
import type { AppLogger } from "../../src/shared/observability/logger.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const option = (key: string): ContextVariableOption => ({ key, label: key, description: `About ${key}.`, archived: false });

describeIntegration("a teammate's edit of a conversation's attribute, against the classifier (Postgres, #1884)", () => {
  const database = new Database(integrationDatabaseUrl);
  const variables = new ContextVariableRepository(database.kysely, { recorder: postgresWorkspaceEventRecorder, delivery: { requestDelivery: () => undefined } });
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as AppLogger;
  const queue = new DefaultBackgroundJobQueue({ writer: new BackgroundJobRepository(database.kysely), wake: new NoopBackgroundJobWake(), logger });
  const audit = { record: vi.fn(async () => undefined) };
  const edits = buildConversationAttributeEdits({ db: database.kysely, values: variables, queue, audit, metrics: null, logger });
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const actor = { accountId, userId: "user-1", surface: "inbox" as const };

  const createChoice = () => variables.create({
    workspaceId, name: `topic_${randomUUID().replaceAll("-", "_")}`, valueType: "enum", options: [option("billing"), option("shipping")],
    trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "on_reference",
  });

  /** A conversation pinned to a release that classifies `classifiedIds`. */
  const createConversationOn = async (classifiedIds: string[]): Promise<string> => {
    const now = new Date().toISOString();
    const enablements = classifiedIds.map((variableId) => ({
      id: randomUUID(), agentId, variableId, source: "classified", resolverSkillId: null, maxAgeSeconds: null, resolverTimeoutMs: null,
      surfacing: "on_reference", enabled: true, createdAt: now, updatedAt: now,
    }));
    const revisionId = randomUUID();
    await database.query(
      "INSERT INTO agent_revisions (id, agent_id, workspace_id, snapshot, source_draft_generation) VALUES ($1, $2, $3, $4::jsonb, 1)",
      [revisionId, agentId, workspaceId, JSON.stringify({ customInstruction: null, directives: [], routines: [], contextVariableEnablements: enablements })],
    );
    const conversationId = randomUUID();
    await database.query(
      "INSERT INTO conversations (id, workspace_id, agent_id, agent_revision_id, source_channel) VALUES ($1, $2, $3, $4, 'website_embed')",
      [conversationId, workspaceId, agentId, revisionId],
    );
    return conversationId;
  };

  /** The classifier as the job runs it, answering `key` for every attribute it is asked about, after `thinkMs`. */
  const classifierAnswering = (key: string, thinkMs = 0) => new ConversationClassificationService({
    targets: new ClassifiedContextVariableReads(database.kysely, new AgentRevisionRuntimeRepository(database.kysely)),
    excerpts: { readExcerpt: async () => ({ summary: null, messages: ["Where is my parcel?"], withheldCount: 0 }) },
    values: new ConversationValueWriterService({ repository: variables }),
    inference: {
      create: async () => ({
        complete: async () => {
          if (thinkMs > 0) await new Promise((resolve) => setTimeout(resolve, thinkMs));
          return { text: JSON.stringify({ attribute_1: { evidence: "What the visitor stated.", option_applies: true, key } }) };
        },
      }),
    },
  });

  /** How long the classifier thinks in each race round, so its write lands before, during and after the teammate's. */
  const raceRounds = [0, 0, 2, 4, 6, 8, 10, 15, 20, 30, 40, 60];

  const storedValue = (variableId: string, conversationId: string) => variables.readValue(variableId, { type: "conversation", id: conversationId });
  const valueEvents = (conversationId: string) => database.query<{ data: { value: unknown; writtenBy: string } }>(
    "SELECT data FROM workspace_events WHERE conversation_id = $1 AND type = 'context_value.changed' ORDER BY position",
    [conversationId],
  );
  const classificationJobs = (conversationId: string) => database.query<{ payload: unknown }>(
    "SELECT payload FROM background_jobs WHERE kind = 'context.classification' AND idempotency_key = $1",
    [conversationId],
  );

  beforeAll(async () => {
    await database.query("INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)", [
      accountId, "Attribute edits", `attribute-edits-${accountId}@example.com`, "hash",
    ]);
    await database.query("INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)", [
      workspaceId, accountId, "Attribute edits", `route-${workspaceId}`,
    ]);
    await database.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)", [agentId, workspaceId, "Front desk"]);
  });

  afterAll(async () => {
    await database.query("DELETE FROM background_jobs WHERE payload->>'workspaceId' = $1", [workspaceId]).catch(() => undefined);
    await database.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]).catch(() => undefined);
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("keeps a teammate's value from the classifier, and records the set as the operator's change", async () => {
    const topic = await createChoice();
    const conversationId = await createConversationOn([topic.id]);
    await classifierAnswering("billing").classifyNow({ workspaceId, conversationId });

    const set = await edits.set({ workspaceId, conversationId, name: topic.name, value: "shipping", actor });
    await classifierAnswering("billing").classifyNow({ workspaceId, conversationId });

    expect(set.attribute).toMatchObject({ value: "shipping", writtenBy: { kind: "operator", ref: "user-1" }, classified: true });
    await expect(storedValue(topic.id, conversationId)).resolves.toMatchObject({ data: "shipping", writtenBy: { kind: "operator", ref: "user-1" } });
    expect((await valueEvents(conversationId)).map((row) => row.data)).toEqual([
      expect.objectContaining({ value: "billing", writtenBy: "classifier" }),
      expect.objectContaining({ value: "shipping", writtenBy: "operator" }),
    ]);
  });

  it("hands the attribute back on reset: it queues the classifier, which then writes it again", async () => {
    const topic = await createChoice();
    const conversationId = await createConversationOn([topic.id]);
    await edits.set({ workspaceId, conversationId, name: topic.name, value: "shipping", actor });

    const reset = await edits.reset({ workspaceId, conversationId, name: topic.name, actor });

    expect(reset).toEqual({ attribute: null, classificationQueued: true });
    await expect(classificationJobs(conversationId)).resolves.toEqual([{ payload: { workspaceId, conversationId } }]);
    await expect(storedValue(topic.id, conversationId)).resolves.toBeNull();

    await classifierAnswering("billing").classifyNow({ workspaceId, conversationId });

    await expect(storedValue(topic.id, conversationId)).resolves.toMatchObject({ data: "billing", writtenBy: { kind: "classifier" } });
    expect((await valueEvents(conversationId)).map((row) => row.data)).toEqual([
      expect.objectContaining({ value: "shipping", writtenBy: "operator" }),
      expect.objectContaining({ value: null, writtenBy: "operator" }),
      expect.objectContaining({ value: "billing", writtenBy: "classifier" }),
    ]);
  });

  it("records nothing for a classifier run that finds what is already stored, or a set of the same option", async () => {
    const topic = await createChoice();
    const conversationId = await createConversationOn([topic.id]);
    await classifierAnswering("billing").classifyNow({ workspaceId, conversationId });
    await classifierAnswering("billing").classifyNow({ workspaceId, conversationId });
    await edits.set({ workspaceId, conversationId, name: topic.name, value: "shipping", actor });
    await edits.set({ workspaceId, conversationId, name: topic.name, value: "shipping", actor });

    expect((await valueEvents(conversationId)).map((row) => row.data.value)).toEqual(["billing", "shipping"]);
  });

  it("keeps the AI's option as the team's when a teammate sets it, records no change for that, and a repeat changes nothing", async () => {
    const topic = await createChoice();
    const conversationId = await createConversationOn([topic.id]);
    await classifierAnswering("billing").classifyNow({ workspaceId, conversationId });
    const auditsOf = () => audit.record.mock.calls.filter((call: unknown[]) => JSON.stringify(call).includes(conversationId));

    const pinned = await edits.set({ workspaceId, conversationId, name: topic.name, value: "billing", actor });
    await classifierAnswering("shipping").classifyNow({ workspaceId, conversationId });
    const repeated = await edits.set({ workspaceId, conversationId, name: topic.name, value: "billing", actor: { ...actor, userId: "user-2" } });

    expect(pinned.attribute).toMatchObject({ value: "billing", writtenBy: { kind: "operator", ref: "user-1" } });
    expect(repeated.attribute).toMatchObject({ value: "billing", writtenBy: { kind: "operator", ref: "user-1" } });
    await expect(storedValue(topic.id, conversationId)).resolves.toMatchObject({ data: "billing", writtenBy: { kind: "operator", ref: "user-1" } });
    expect((await valueEvents(conversationId)).map((row) => [row.data.value, row.data.writtenBy])).toEqual([["billing", "classifier"]]);
    expect(auditsOf()).toHaveLength(1);
  });

  // Each round races the two writers on a fresh conversation. Whichever commits first, the
  // teammate's value stands under the overwrite rule, and the log holds exactly the changes the
  // value went through: one event per stored change, none for the write the rule turned away.
  it("races a teammate's set against the classifier: the teammate's option stands, each change recorded once", async () => {
    const topic = await createChoice();
    const conversations = await Promise.all(raceRounds.map(async (thinkMs) => {
      const conversationId = await createConversationOn([topic.id]);
      await Promise.all([
        edits.set({ workspaceId, conversationId, name: topic.name, value: "shipping", actor }),
        classifierAnswering("billing", thinkMs).classifyNow({ workspaceId, conversationId }),
      ]);
      return conversationId;
    }));

    for (const conversationId of conversations) {
      await expect(storedValue(topic.id, conversationId)).resolves.toMatchObject({ data: "shipping", writtenBy: { kind: "operator", ref: "user-1" } });
      const events = (await valueEvents(conversationId)).map((row) => [row.data.value, row.data.writtenBy]);
      expect([
        [["shipping", "operator"]],
        [["billing", "classifier"], ["shipping", "operator"]],
      ]).toContainEqual(events);
    }
  });

  it("races a teammate keeping the AI's option against the AI changing it: the kept option stands, each change recorded once", async () => {
    const topic = await createChoice();
    const conversations = await Promise.all(raceRounds.map(async (thinkMs) => {
      const conversationId = await createConversationOn([topic.id]);
      await classifierAnswering("billing").classifyNow({ workspaceId, conversationId });
      await Promise.all([
        edits.set({ workspaceId, conversationId, name: topic.name, value: "billing", actor }),
        classifierAnswering("shipping", thinkMs).classifyNow({ workspaceId, conversationId }),
      ]);
      return conversationId;
    }));

    for (const conversationId of conversations) {
      await expect(storedValue(topic.id, conversationId)).resolves.toMatchObject({ data: "billing", writtenBy: { kind: "operator", ref: "user-1" } });
      const events = (await valueEvents(conversationId)).map((row) => [row.data.value, row.data.writtenBy]);
      expect([
        [["billing", "classifier"]],
        [["billing", "classifier"], ["shipping", "classifier"], ["billing", "operator"]],
      ]).toContainEqual(events);
    }
  });

  it("clears without queueing the classifier when the conversation's release doesn't classify the attribute, and resets nothing twice", async () => {
    const topic = await createChoice();
    const conversationId = await createConversationOn([]);
    await edits.set({ workspaceId, conversationId, name: topic.name, value: "billing", actor });

    await expect(edits.reset({ workspaceId, conversationId, name: topic.name, actor })).resolves.toEqual({ attribute: null, classificationQueued: false });
    await expect(edits.reset({ workspaceId, conversationId, name: topic.name, actor })).resolves.toEqual({ attribute: null, classificationQueued: false });
    await expect(classificationJobs(conversationId)).resolves.toEqual([]);
    expect(await valueEvents(conversationId)).toHaveLength(2);
  });

  it("refuses a Private attribute, writing and recording nothing", async () => {
    const careNeed = await variables.create({
      workspaceId, name: `care_need_${randomUUID().replaceAll("-", "_")}`, valueType: "enum", options: [option("dental")],
      trustTier: "unverified", sensitivity: "sensitive", defaultSurfacing: "on_reference",
    });
    const conversationId = await createConversationOn([]);

    await expect(edits.set({ workspaceId, conversationId, name: careNeed.name, value: "dental", actor }))
      .rejects.toMatchObject({ statusCode: 400, code: "attribute_not_editable", details: { reason: "private" } });
    await expect(storedValue(careNeed.id, conversationId)).resolves.toBeNull();
    expect(await valueEvents(conversationId)).toEqual([]);
  });

  it("refuses a conversation the workspace doesn't have", async () => {
    const topic = await createChoice();

    await expect(edits.set({ workspaceId, conversationId: randomUUID(), name: topic.name, value: "billing", actor }))
      .rejects.toMatchObject({ statusCode: 404, message: "Conversation not found" });
    await expect(edits.reset({ workspaceId, conversationId: randomUUID(), name: topic.name, actor }))
      .rejects.toMatchObject({ statusCode: 404, message: "Conversation not found" });
  });
});
