import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { ClassifiedContextVariableReads } from "../../src/db/repositories/classifiedContextVariableReads.js";
import { ContextVariableRepository } from "../../src/db/repositories/contextVariableRepository.js";
import { ConversationRepository } from "../../src/db/repositories/conversationRepository.js";
import { ConversationSummaryRepository } from "../../src/db/repositories/conversationSummaryRepository.js";
import { MessageRepository } from "../../src/db/repositories/messageRepository.js";
import { postgresWorkspaceEventRecorder } from "../../src/db/repositories/workspaceEventLogRepository.js";
import { ContextClassificationExcerptReader } from "../../src/modules/chat/composition.js";
import { ConversationValueWriterService } from "../../src/modules/context-variables/public.js";
import { CONTEXT_CLASSIFICATION_PROMPT_VERSION, ConversationClassificationService } from "../../src/modules/contextClassification/public.js";
import { sensitiveTurnMetadata } from "../../src/shared/domain/sensitiveTranscript.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("context classification over a stored conversation (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const contextVariableRepository = new ContextVariableRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const prompts: string[] = [];
  const complete = vi.fn(async (request: { prompt: string }) => {
    prompts.push(request.prompt);
    return { text: JSON.stringify({ attribute_1: "billing" }) };
  });
  // The rewrite-tier model is stubbed; the reads, the excerpt and the writes are the real ones.
  const classifier = new ConversationClassificationService({
    targets: new ClassifiedContextVariableReads(database.kysely),
    excerpts: new ContextClassificationExcerptReader({
      conversations: new ConversationRepository(database.kysely, postgresWorkspaceEventRecorder),
      messages: new MessageRepository(database.kysely),
      summaries: new ConversationSummaryRepository(database.kysely),
    }),
    values: new ConversationValueWriterService({ repository: contextVariableRepository }),
    inference: { create: async () => ({ complete }) as never },
  });

  const createTopic = () => contextVariableRepository.create({
    workspaceId, name: `topic_${randomUUID().replaceAll("-", "_")}`, valueType: "enum",
    options: [{ key: "billing", label: "Billing", description: "Invoices.", archived: false }, { key: "shipping", label: "Shipping", description: null, archived: false }],
    trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "on_reference",
  });

  const createConversationClassifying = async (variableId: string): Promise<string> => {
    const revisionId = randomUUID();
    const enablement = { id: randomUUID(), agentId, variableId, source: "classified", resolverSkillId: null, maxAgeSeconds: null, resolverTimeoutMs: null, surfacing: "on_reference", enabled: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await database.query(
      "INSERT INTO agent_revisions (id, agent_id, workspace_id, snapshot, source_draft_generation) VALUES ($1, $2, $3, $4::jsonb, 1)",
      [revisionId, agentId, workspaceId, JSON.stringify({ contextVariableEnablements: [enablement] })],
    );
    const conversationId = randomUUID();
    await database.query("INSERT INTO conversations (id, workspace_id, agent_id, agent_revision_id) VALUES ($1, $2, $3, $4)", [conversationId, workspaceId, agentId, revisionId]);
    return conversationId;
  };

  const addMessage = (conversationId: string, role: string, content: string, metadata: object = {}) =>
    database.query(
      "INSERT INTO messages (id, workspace_id, conversation_id, role, content, metadata_json, source, created_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, clock_timestamp())",
      [randomUUID(), workspaceId, conversationId, role, content, JSON.stringify(metadata), role === "user" ? "customer" : "ai_agent"],
    );

  beforeAll(async () => {
    await database.query("INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)", [accountId, "Classify Co", `classify-${accountId}@example.com`, "hash"]);
    await database.query("INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)", [workspaceId, accountId, "Classify Workspace", `route-${workspaceId}`]);
    await database.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)", [agentId, workspaceId, "Classify Agent"]);
  });

  afterAll(async () => {
    await database.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]).catch(() => undefined);
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("sends the visitor's messages without a sensitive turn's, and stores the answer as the classifier's", async () => {
    const topic = await createTopic();
    const conversationId = await createConversationClassifying(topic.id);
    await addMessage(conversationId, "user", "My date of birth is 1 May 1980", sensitiveTurnMetadata(["date_of_birth"]));
    await addMessage(conversationId, "assistant", "Thanks, noted.");
    await addMessage(conversationId, "user", "Why was I charged twice this month?");

    const result = await classifier.classifyNow({ workspaceId, conversationId });

    expect(result.outcome).toBe("written");
    expect(prompts.at(-1)).toContain("Why was I charged twice this month?");
    expect(prompts.at(-1)).not.toContain("1980");
    expect(prompts.at(-1)).not.toContain("Thanks, noted.");
    await expect(contextVariableRepository.readValue(topic.id, { type: "conversation", id: conversationId })).resolves.toMatchObject({
      data: "billing",
      writtenBy: { kind: "classifier", ref: CONTEXT_CLASSIFICATION_PROMPT_VERSION },
    });
  });

  it("makes no call and keeps the value when the host set it", async () => {
    const topic = await createTopic();
    const conversationId = await createConversationClassifying(topic.id);
    await addMessage(conversationId, "user", "Where is my parcel?");
    await contextVariableRepository.upsertValue(topic.id, { type: "conversation", id: conversationId }, "shipping", { kind: "api", ref: "credential-1" });
    const calls = complete.mock.calls.length;

    await expect(classifier.classifyNow({ workspaceId, conversationId })).resolves.toMatchObject({ outcome: "skipped_override" });
    expect(complete.mock.calls.length).toBe(calls);
    await expect(contextVariableRepository.readValue(topic.id, { type: "conversation", id: conversationId })).resolves.toMatchObject({
      data: "shipping",
      writtenBy: { kind: "api" },
    });
  });
});
