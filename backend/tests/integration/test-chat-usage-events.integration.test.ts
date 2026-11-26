import { randomUUID } from "node:crypto";

import { DefaultConversationEngine } from "@radioso/conversation-engine";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import type { AgentRevision } from "../../src/modules/agents/agentRevision.js";
import { projectInternalAgentConfig } from "../../src/modules/agents/agentConfig.js";
import type { ConversationAgent } from "../../src/modules/agents/domain.js";
import { defaultAgentVoiceSettings, unpublishedAgentPublicIdentity } from "../../src/modules/agents/public.js";
import { TrustedTestExecutionRunnerAdapter } from "../../src/modules/chat/composition.js";
import { LlmTurnRouter, ModelTurnRouterGateway } from "../../src/modules/chat/services/turnRouter.js";
import type { RetrievalTurnPort } from "../../src/modules/chat/services/retrievalTurnDispatch.js";
import type { TurnSkill } from "../../src/modules/chat/services/turnOutcome.js";
import { WorkbenchReplayRunner } from "../../src/modules/chat/services/workbenchReplayRunner.js";
import { ConversationClassificationService } from "../../src/modules/contextClassification/public.js";
import type { ContextVariable } from "../../src/modules/context-variables/public.js";
import { Database } from "../../src/shared/infra/database.js";
import { ModelInferencePipelineService } from "../../src/shared/infra/llm/modelInferencePipeline.js";
import type { LlmProviderMetadata, TextGenerationClient, TextGenerationRequest, TextGenerationResult, TextGenerationStreamResult } from "../../src/shared/infra/llm/providerTypes.js";
import { DurableUsageEventRecorder } from "../../src/shared/infra/usage/durableUsageEventRecorder.js";
import { createAuditService } from "../support/fakes.js";
import { websiteEmbedFixture } from "../support/websiteEmbedFixture.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// A Test Chat side is not a stored conversation: its conversation and message ids name no row in
// `conversations` or `messages`. This drives the real Test Chat adapter, the real replay runner and
// the real classifier over a scripted model, and reads the usage ledger they write to.
const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

/** Answers the router with a direct route and the classifier with its one attribute. */
class ScriptedClient implements TextGenerationClient {
  readonly metadata: LlmProviderMetadata = { capability: "chat", provider: "openai", model: "gpt-test" };
  readonly calls: TextGenerationRequest[] = [];
  async complete(request: TextGenerationRequest): Promise<TextGenerationResult> {
    this.calls.push(request);
    const text = request.responseFormat
      ? JSON.stringify({ attribute_1: { key: "billing", option_applies: true } })
      : JSON.stringify({ route: "direct", isIdentityQuestion: false });
    return { text, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, quality: "actual" } };
  }
  stream(): TextGenerationStreamResult {
    throw new Error("not used");
  }
}

const buildAgent = (id: string, workspaceId: string): ConversationAgent => ({
  ...unpublishedAgentPublicIdentity(),
  voice: defaultAgentVoiceSettings(),
  id, workspaceId, name: "Support", createdAt: new Date(0), updatedAt: new Date(0),
  customInstruction: "Answer briefly.", suggestedQuestionsEnabled: true, assistantLinkUtmEnabled: true, citationDisplayEnabled: true,
  contactRequestsEnabled: true, webhookExportsEnabled: true, contactRequestDelivery: { recipientEmails: [], webhook: null },
  retrievalEnabled: true, sourceScope: { mode: "all" }, skillSettings: {}, logo: null,
  theme: { brand: "#000000", brandText: "#ffffff", surface: "#ffffff", text: "#000000" },
  branding: { hidePoweredBy: false, privacyPolicyUrl: null, privacyNotice: {} },
  greetingInstruction: "", assistantDefaultLocale: null, proactiveGreetingEnabled: false, mechanicsReplies: {},
  chatModelOverride: { provider: "openai", model: "gpt-5-mini" },
  surfaceSettings: {
    authenticatedChat: { enabled: true },
    anonymousChat: { enabled: false, token: null },
    websiteEmbed: websiteEmbedFixture({
      enabled: false, token: null, allowedOrigins: [], launcherLabel: "Chat", launcherPosition: "bottom-right",
      theme: { brand: "#000000", brandText: "#ffffff", surface: "#ffffff", text: "#000000" }, copy: {}, expertOverrides: {},
    }),
    extensions: {},
  },
  authoredDirectives: [],
});

/** A skill that answers without a model call, so the turn's only calls are the router's and the classifier's. */
const answerSkill = (): TurnSkill => ({
  definition: { name: "replay.answer", outcomeKinds: ["replay"] },
  selects: () => true,
  dispatch: (session) => ({
    kind: "replay", skillName: "replay.answer", outcome: { status: "completed", answer: "Hello." },
    stagedContext: session.stagedContext, steering: session.directiveSteering?.rules ?? [], trace: session.turnTrace,
  }),
  renderer: {
    supports: (outcome) => outcome.kind === "replay",
    render: async (outcome) => ({ answer: outcome.outcome.answer ?? "", skillName: outcome.skillName, skillOutcome: outcome.outcome.status, skillStatus: outcome.outcome.status }),
  },
});

const noRetrieval: RetrievalTurnPort = {
  interpret: async (request) => ({ request, traceStartedAtMs: Date.now(), context: { result: {} as never, startedAt: Date.now(), durationMs: 0 }, interpretation: { startedAt: Date.now(), durationMs: 0 } }),
  dispatch: async (input) => ({
    rewrittenQuery: input.interpreted.request.query, contexts: [], systemPrompt: "", prompt: "", citations: [],
    responseIdentity: null, responseSettings: { citationDisplayEnabled: true, suggestedQuestionsEnabled: false, suggestedQuestionsCount: 0, responseLanguagePolicy: "match_user_question" },
    diagnostics: { execution: { surface: "assistant", path: "assistant_retrieval", retrievalInvoked: false }, retrievalSkipped: true },
    trace: { traceId: "t", startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), totalDurationMs: 0, stages: [], links: [] },
  }) as never,
};

describeIntegration("Test Chat model calls on the usage ledger", () => {
  let database: Database;

  beforeAll(() => {
    database = new Database(integrationDatabaseUrl);
  });
  afterAll(async () => {
    await database.close();
  });

  const seed = async () => {
    const account = await new AccountRepository(database.kysely).create({ name: "Test Chat Usage Org", email: `test-chat-usage-${randomUUID()}@example.com`, passwordHash: "hash" });
    const workspace = await new WorkspaceRepository(database.kysely).create(account.id, "Test Chat Usage Workspace");
    const agentId = randomUUID();
    await database.query("INSERT INTO agents (id,workspace_id,name) VALUES ($1,$2,$3)", [agentId, workspace.id, "test"]);
    return { accountId: account.id, workspaceId: workspace.id, agentId };
  };

  const topic: ContextVariable = {
    id: randomUUID(), workspaceId: "", name: "topic", description: null, valueType: "enum",
    options: [{ key: "billing", label: "Billing", description: null, archived: false }],
    trustTier: "unverified", sensitivity: "normal", defaultSurfacing: "on_reference",
    createdAt: new Date(0), updatedAt: new Date(0),
  };

  /** The adapter and runner over the real recorder, the way composition assembles them. */
  const testChat = (workspaceId: string, agentId: string) => {
    const client = new ScriptedClient();
    const warn = vi.fn();
    // The recorder warns when it has to drop a link its foreign key rejected.
    const pipeline = new ModelInferencePipelineService(client, new DurableUsageEventRecorder(database.kysely, { warn }));
    const replay = new WorkbenchReplayRunner({
      retrievalTurn: noRetrieval,
      auditService: createAuditService(),
      turnSkills: [answerSkill()],
      conversationEngine: new DefaultConversationEngine(),
      turnRouter: new LlmTurnRouter(new ModelTurnRouterGateway(pipeline)),
    });
    const classifier = new ConversationClassificationService({
      targets: { readDefinitions: async () => [{ ...topic, workspaceId }], readConversationTargets: async () => null },
      excerpts: { readExcerpt: async () => null },
      values: { write: async () => "stored" } as never,
      inference: { create: async ({ modelCallContext }) => ({
        metadata: pipeline.metadata,
        complete: (request: Omit<Parameters<typeof pipeline.complete>[0], "operation">) => pipeline.complete({ ...request, operation: modelCallContext }),
        stream: (request: Omit<Parameters<typeof pipeline.stream>[0], "operation">) => pipeline.stream({ ...request, operation: modelCallContext }),
      }) },
      logger: { warn },
    });
    const revision: AgentRevision = {
      id: randomUUID(), sourceDraftGeneration: 1, sourceBasePublishedRevisionId: null, createdAt: new Date(0), publishedAt: null, publishedVersion: null,
      snapshot: {
        customInstruction: null, directives: [], routines: [],
        contextVariableEnablements: [{ variableId: topic.id, enabled: true, source: "classified" }] as never,
      },
    };
    const adapter = new TrustedTestExecutionRunnerAdapter({
      replay,
      liveAgentConfig: { find: async () => projectInternalAgentConfig(buildAgent(agentId, workspaceId)) },
      revisions: { findRevision: async () => revision },
      classifier,
    });
    return { adapter, revision, warn };
  };

  const send = async (input: { adapter: ReturnType<typeof testChat>["adapter"]; revision: AgentRevision; workspaceId: string; agentId: string; accountId: string; conversationId: string; userMessageId: string; attemptId: string }) => {
    const turn = input.adapter.stream({
      workspaceId: input.workspaceId, agentId: input.agentId, accountId: input.accountId, candidateRevision: input.revision,
      conversationId: input.conversationId, attemptId: input.attemptId, userMessageId: input.userMessageId,
      message: "Where is my invoice?", history: [], continuation: null, testValues: [], executionMode: "safe_test", skillEffects: "suppressed",
    });
    let step = await turn.next();
    while (!step.done) step = await turn.next();
  };

  const countBySurface = async (workspaceId: string) => Object.fromEntries((await database.query<{ surface: string; operation: string; n: string }>(
    "SELECT surface, operation, COUNT(*) AS n FROM usage_events WHERE workspace_id = $1 GROUP BY surface, operation ORDER BY surface, operation", [workspaceId],
  )).map((row) => [`${row.surface}:${row.operation}`, Number(row.n)]));

  it("records the replayed turn's calls under Test Chat and the classifier's under its own surface, on the first insert", async () => {
    const { accountId, workspaceId, agentId } = await seed();
    const { adapter, revision, warn } = testChat(workspaceId, agentId);

    await send({ adapter, revision, workspaceId, agentId, accountId, conversationId: randomUUID(), userMessageId: randomUUID(), attemptId: randomUUID() });

    const counts = await countBySurface(workspaceId);
    expect(counts["test_execution:turn_router"]).toBe(1);
    expect(counts["context_classification:classification"]).toBe(1);
    // The first insert succeeded: no call named a conversation or message the ledger has no row for.
    expect(warn).not.toHaveBeenCalled();
    const linked = await database.query<{ n: string }>("SELECT COUNT(*) AS n FROM usage_events WHERE workspace_id = $1 AND (conversation_id IS NOT NULL OR message_id IS NOT NULL)", [workspaceId]);
    expect(Number(linked[0]?.n)).toBe(0);
    expect(Object.keys(counts).some((key) => key.startsWith("assistant:"))).toBe(false);
  });

  it("meters a retried turn again: the retry keeps the message id but is a new attempt", async () => {
    const { accountId, workspaceId, agentId } = await seed();
    const { adapter, revision } = testChat(workspaceId, agentId);
    const turn = { adapter, revision, workspaceId, agentId, accountId, conversationId: randomUUID(), userMessageId: randomUUID() };

    await send({ ...turn, attemptId: randomUUID() });
    await send({ ...turn, attemptId: randomUUID() });

    const counts = await countBySurface(workspaceId);
    expect(counts["test_execution:turn_router"]).toBe(2);
    expect(counts["context_classification:classification"]).toBe(2);
  });

  it("keeps the spend of a call that names a conversation the ledger has no row for, and says which call", async () => {
    const { accountId, workspaceId } = await seed();
    const warn = vi.fn();
    const pipeline = new ModelInferencePipelineService(new ScriptedClient(), new DurableUsageEventRecorder(database.kysely, { warn }));

    await pipeline.complete({
      prompt: "hello",
      operation: { accountId, workspaceId, conversationId: randomUUID(), messageId: randomUUID(), surface: "assistant", operation: "answer", attemptKey: "answer:1" },
    });

    expect(await countBySurface(workspaceId)).toEqual({ "assistant:answer": 1 });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, surface: "assistant", operation: "answer" }), expect.any(String));
  });
});
