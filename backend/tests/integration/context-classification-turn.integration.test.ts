import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { ConversationRepository } from "../../src/db/repositories/conversationRepository.js";
import { ConversationSummaryRepository } from "../../src/db/repositories/conversationSummaryRepository.js";
import { MessageRepository } from "../../src/db/repositories/messageRepository.js";
import { postgresWorkspaceEventRecorder } from "../../src/db/repositories/workspaceEventLogRepository.js";
import { ContextClassificationExcerptReader } from "../../src/modules/chat/composition.js";
import type { ChatGateway } from "../../src/modules/chat/services/chatService.js";
import type { AgentContextVariableEnablement } from "../../src/modules/context-variables/public.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";
import { CONSENT_ROUTINE_ID, classBooking, createRoutineConsentChatHarness } from "./support/routineConsentChatHarness.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

/** The class booking's model: it starts the routine, reads a typed grant, and collects the name and the Private injury. */
const scriptedModel: ChatGateway = {
  async answer(input) {
    const prompt = input.systemPrompt ?? "";
    if (prompt.includes("wants to start any registered routine")) {
      return JSON.stringify({ matches: [{ routineId: CONSENT_ROUTINE_ID, confidence: 0.95, variables: {} }] });
    }
    if (prompt.includes("A person was just shown the consent request")) {
      return JSON.stringify({ decision: input.query.startsWith("Yes") ? "granted" : "unclear" });
    }
    if (prompt.includes("claimsAuthority") || prompt.includes("Declared slots")) {
      const variables: Record<string, Record<string, string>> = { "My name is Ada": { name: "Ada" }, "Yes, and I have a sore knee": { injury: "sore knee" } };
      return JSON.stringify({ variables: variables[input.query] ?? {}, claimsAuthority: false, condition: null, offTopic: false });
    }
    return `[step reply to: ${input.query}]`;
  },
  async *streamAnswer() {
    throw new Error("these turns run the non-streaming path");
  },
};

describeIntegration("attribute classification after a chat turn (Postgres, #1884)", () => {
  const database = new Database(integrationDatabaseUrl);
  const harness = createRoutineConsentChatHarness(database, scriptedModel);
  const excerpts = new ContextClassificationExcerptReader({
    conversations: new ConversationRepository(database.kysely, postgresWorkspaceEventRecorder),
    messages: new MessageRepository(database.kysely),
    summaries: new ConversationSummaryRepository(database.kysely),
  });

  beforeAll(async () => {
    await runAllTestMigrations(database);
  });

  afterAll(async () => {
    await harness.cleanup();
    await database.close().catch(() => undefined);
  });

  const classified = (agentId: string): AgentContextVariableEnablement => ({
    id: randomUUID(), agentId, variableId: randomUUID(), source: "classified", resolverSkillId: null, maxAgeSeconds: null,
    resolverTimeoutMs: null, surfacing: "on_reference", enabled: true, createdAt: new Date(), updatedAt: new Date(),
  });

  const classificationJobs = (conversationId: string) => database.query<{ payload: unknown; rerun_requested: boolean }>(
    "SELECT payload, rerun_requested FROM background_jobs WHERE kind = 'context.classification' AND idempotency_key = $1",
    [conversationId],
  );

  it("writes the classification job in each committed turn, a turn that held a Private field included, and its run reads without that message", async () => {
    const conversation = await harness.startConversation({
      definition: classBooking("continue"),
      contextVariableEnablements: (agentId) => [classified(agentId)],
      backgroundJobs: true,
    });

    await conversation.send("I want to book a class");

    await expect(classificationJobs(conversation.conversationId)).resolves.toEqual([
      { payload: { workspaceId: conversation.workspaceId, conversationId: conversation.conversationId }, rerun_requested: false },
    ]);

    // The worker ran it; the next turns each write it again.
    await database.query("DELETE FROM background_jobs WHERE kind = 'context.classification' AND idempotency_key = $1", [conversation.conversationId]);
    await conversation.send("My name is Ada");
    await database.query("DELETE FROM background_jobs WHERE kind = 'context.classification' AND idempotency_key = $1", [conversation.conversationId]);
    await conversation.send("Yes, and I have a sore knee");

    await expect(classificationJobs(conversation.conversationId)).resolves.toHaveLength(1);
    const excerpt = await excerpts.readExcerpt({ workspaceId: conversation.workspaceId, conversationId: conversation.conversationId, maxMessages: 6, maxMessageChars: 1_000 });
    expect(excerpt?.messages).toContain("My name is Ada");
    expect(excerpt?.messages.join(" ")).not.toContain("sore knee");
    expect(excerpt?.withheldCount).toBeGreaterThan(0);
  });

  it("writes none for an agent whose release classifies nothing", async () => {
    const conversation = await harness.startConversation({ definition: classBooking("continue"), backgroundJobs: true });

    await conversation.send("I want to book a class");

    await expect(classificationJobs(conversation.conversationId)).resolves.toEqual([]);
    await expect(database.query("SELECT 1 FROM background_jobs WHERE kind = 'conversation.summary_refresh' AND idempotency_key = $1", [conversation.conversationId]))
      .resolves.toHaveLength(1);
  });
});
