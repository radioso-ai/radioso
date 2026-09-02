import { describe, expect, it } from "vitest";

import type { AgentRepositoryPort } from "../../src/db/repositories/agentRepository.js";
import type { ConversationRecord, ConversationRepositoryPort } from "../../src/db/repositories/conversationRepository.js";
import type { MessageRecord, MessageRepositoryPort } from "../../src/db/repositories/messageRepository.js";
import type { AuthoredDirective, AuthoredDirectiveInput } from "../../src/modules/agents/authoredDirectives.js";
import type { ConversationAgent } from "../../src/modules/agents/domain.js";
import type { RetrievalSettingsRecord } from "../../src/modules/settings/contracts/retrieval.js";
import { defaultRetrievalSettings, freezeRetrievalSettings } from "../../src/modules/settings/contracts/retrieval.js";
import { createRetrievalSkillSettingsResolver } from "../../src/app/composition/skillSettingsResolver.js";
import type { RetrievalDefaultsProvider } from "../../src/modules/retrieval/public.js";
import {
  EvalSnapshotService,
  type EvalSnapshotExternalSkillsPort,
} from "../../src/modules/eval/services/evalSnapshotService.js";
import type {
  CreateCaseInput,
  CreateRunInput,
  CreateSnapshotInput,
  EvalRepositoryPort,
} from "../../src/modules/eval/services/evalRepository.js";
import type {
  EvalAssertion,
  EvalCase,
  EvalCaseStatus,
  EvalRun,
  EvalSnapshot,
} from "../../src/modules/eval/domain/types.js";

const fixedDate = new Date("2026-05-23T12:00:00.000Z");

const agent = (): ConversationAgent => ({
  id: "agent-1",
  workspaceId: "ws-1",
  name: "Snapshot Bot",
  createdAt: fixedDate,
  updatedAt: fixedDate,
  customInstruction: "Answer from the captured agent config.",
  suggestedQuestionsEnabled: false,
  assistantLinkUtmEnabled: false,
  citationDisplayEnabled: false,
  contactRequestsEnabled: true,
  webhookExportsEnabled: true,
  contactRequestDelivery: {
    recipientEmails: ["ops@example.com"],
    webhook: { url: "https://hooks.example.com/contact" },
  },
  retrievalEnabled: false,
  logo: null,
  theme: {
    brand: "#111111",
    brandText: "#ffffff",
    surface: "#ffffff",
    text: "#111111",
  },
  branding: {
    hidePoweredBy: false,
    privacyPolicyUrl: null,
  },
  greetingInstruction: "Greet briefly.",
  assistantDefaultLocale: "en-US",
  proactiveGreetingEnabled: true,
  sourceScope: { mode: "selected", sourceIds: ["source-1", "source-2"] },
  surfaceSettings: {
    authenticatedChat: { enabled: true },
    anonymousChat: { enabled: true, token: "anonymous-token" },
    websiteEmbed: {
      enabled: true,
      token: "embed-token",
      allowedOrigins: ["https://example.com"],
      launcherLabel: "Ask",
      launcherPosition: "bottom-right",
      theme: {
        brand: "#111111",
        brandText: "#ffffff",
        surface: "#ffffff",
        text: "#111111",
      },
      copy: {},
      expertOverrides: {},
    },
    extensions: {},
  },
  skillSettings: {
    "retrieval.answer": {
      vectorTopK: 7,
      rerankEnabled: true,
    },
  },
  chatModelOverride: {
    provider: "openai",
    model: "gpt-5-mini",
  },
  authoredDirectives: [],
});

class StubConversationRepository implements ConversationRepositoryPort {
  constructor(private readonly conversation: ConversationRecord | null) {}

  async create(): Promise<ConversationRecord> {
    throw new Error("not implemented");
  }

  async createWithInitialAssistantMessage(): Promise<{ conversation: ConversationRecord; assistantMessage: MessageRecord }> {
    throw new Error("not implemented");
  }

  async listPageByWorkspaceId(): Promise<{ conversations: ConversationRecord[]; total: number; nextCursor: string | null; hasMore: boolean }> {
    throw new Error("not implemented");
  }

  async countByWorkspaceId(): Promise<number> {
    throw new Error("not implemented");
  }

  async listPageByAnonymousSession(): Promise<{ conversations: ConversationRecord[]; total: number; nextCursor: string | null; hasMore: boolean }> {
    throw new Error("not implemented");
  }

  async findByIdAndWorkspaceId(conversationId: string, workspaceId: string): Promise<ConversationRecord | null> {
    return this.conversation?.id === conversationId && this.conversation.workspaceId === workspaceId
      ? this.conversation
      : null;
  }

  async findByIdAndAnonymousSession(): Promise<ConversationRecord | null> {
    throw new Error("not implemented");
  }

  async setVerifiedCustomerId(): Promise<void> {}

  async setTitle(): Promise<void> {}

  async getTitle(): Promise<string | null> {
    return null;
  }

  async touch(): Promise<void> {}
}

class StubMessageRepository implements MessageRepositoryPort {
  constructor(private readonly messages: MessageRecord[]) {}

  async findByIdAndWorkspaceId(workspaceId: string, messageId: string): Promise<MessageRecord | null> {
    return this.messages.find((message) => message.workspaceId === workspaceId && message.id === messageId) ?? null;
  }

  async listByConversationId(workspaceId: string, conversationId: string): Promise<MessageRecord[]> {
    return this.messages.filter((message) =>
      message.workspaceId === workspaceId && message.conversationId === conversationId);
  }

  async listRecentByConversationId(): Promise<MessageRecord[]> {
    throw new Error("not implemented");
  }

  async countByConversationId(): Promise<number> {
    throw new Error("not implemented");
  }

  async listWindowByConversationId(): Promise<{ messages: MessageRecord[]; total: number; nextCursor: string | null; hasMore: boolean }> {
    throw new Error("not implemented");
  }

  async listSinceByConversationId(): Promise<{ messages: MessageRecord[]; latestCursor: string | null }> {
    throw new Error("not implemented");
  }

  async summarizeByConversationIds(): Promise<Map<string, { messageCount: number; userMessageCount: number; assistantMessageCount: number; preview: string | null }>> {
    throw new Error("not implemented");
  }

  async create(): Promise<MessageRecord> {
    throw new Error("not implemented");
  }
}

class StubAgentRepository implements AgentRepositoryPort {
  constructor(private readonly value: ConversationAgent | null) {}

  async create(): Promise<ConversationAgent> {
    throw new Error("not implemented");
  }

  async findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<ConversationAgent | null> {
    return this.value?.id === agentId && this.value.workspaceId === workspaceId ? this.value : null;
  }

  async findDefaultByWorkspaceId(): Promise<ConversationAgent | null> {
    throw new Error("not implemented");
  }

  async findByAnonymousChatToken(): Promise<ConversationAgent | null> {
    throw new Error("not implemented");
  }

  async findByWebsiteEmbedToken(): Promise<ConversationAgent | null> {
    throw new Error("not implemented");
  }

  async listByWorkspaceId(): Promise<ConversationAgent[]> {
    throw new Error("not implemented");
  }

  async update(): Promise<ConversationAgent> {
    throw new Error("not implemented");
  }

  async listDirectives() {
    return [];
  }

  async createDirective(
    agentId: string,
    _workspaceId: string,
    input: AuthoredDirectiveInput,
  ): Promise<AuthoredDirective> {
    return {
      id: "directive-1",
      agentId,
      name: input.name,
      condition: input.condition,
      action: input.action,
      priority: null,
      binding: input.binding ?? null,
      lifecycle: null,
      requiredCapabilities: input.requiredCapabilities ?? [],
      dependsOn: input.dependsOn ?? [],
      excludes: input.excludes ?? [],
      routes: input.routes ?? [],
      surfaces: input.surfaces ?? [],
      tags: input.tags ?? [],
      description: input.description ?? null,
      enabled: input.enabled ?? true,
      metadata: input.metadata ?? {},
      createdAt: fixedDate,
      updatedAt: fixedDate,
    };
  }

  async updateDirective(
    agentId: string,
    _workspaceId: string,
    directiveId: string,
    input: Partial<AuthoredDirectiveInput>,
  ): Promise<AuthoredDirective> {
    return {
      id: directiveId,
      agentId,
      name: input.name ?? "directive",
      condition: input.condition ?? { kind: "always" },
      action: input.action ?? "Act.",
      priority: null,
      binding: input.binding ?? null,
      lifecycle: null,
      requiredCapabilities: input.requiredCapabilities ?? [],
      dependsOn: input.dependsOn ?? [],
      excludes: input.excludes ?? [],
      routes: input.routes ?? [],
      surfaces: input.surfaces ?? [],
      tags: input.tags ?? [],
      description: input.description ?? null,
      enabled: input.enabled ?? true,
      metadata: input.metadata ?? {},
      createdAt: fixedDate,
      updatedAt: fixedDate,
    };
  }

  async deleteDirective() {
    return false;
  }

  async setDefault(): Promise<void> {}

  async deleteByIdAndWorkspaceId(): Promise<boolean> {
    return false;
  }

  async countByWorkspaceId(): Promise<number> {
    return this.value ? 1 : 0;
  }
}

class StubRetrievalDefaultsProvider implements RetrievalDefaultsProvider {
  public readonly settings: RetrievalSettingsRecord = {
    ...defaultRetrievalSettings("ws-1"),
    vectorTopK: 5,
    suggestedQuestionsEnabled: true,
    suggestedQuestionsCount: 3,
    rerankEnabled: false,
  };

  getDefaults(workspaceId: string): RetrievalSettingsRecord {
    return { ...this.settings, workspaceId };
  }
}

class CapturingEvalRepository implements EvalRepositoryPort {
  public lastCreateInput: CreateSnapshotInput | null = null;

  async createSnapshot(input: CreateSnapshotInput): Promise<EvalSnapshot> {
    this.lastCreateInput = input;
    return {
      id: "snapshot-1",
      capturedAt: fixedDate.toISOString(),
      ...input,
    };
  }

  async findSnapshot(): Promise<EvalSnapshot | null> {
    throw new Error("not implemented");
  }

  async createCase(): Promise<EvalCase> {
    throw new Error("not implemented");
  }

  async findCase(): Promise<EvalCase | null> {
    throw new Error("not implemented");
  }

  async listCases(): Promise<EvalCase[]> {
    throw new Error("not implemented");
  }

  async listCasesWithLatestRun(): Promise<never> {
    throw new Error("not implemented");
  }

  async deleteCase(): Promise<boolean> {
    throw new Error("not implemented");
  }

  async updateCaseAssertions(): Promise<EvalCase> {
    throw new Error("not implemented");
  }

  async updateCaseName(): Promise<EvalCase> {
    throw new Error("not implemented");
  }

  async updateCaseExecutionMode(): Promise<EvalCase> {
    throw new Error("not implemented");
  }

  async createRun(_input: CreateRunInput): Promise<EvalRun> {
    throw new Error("not implemented");
  }

  async listRunsForCase(): Promise<EvalRun[]> {
    throw new Error("not implemented");
  }

  async updateCaseLastRun(
    _workspaceId: string,
    _caseId: string,
    _lastRunId: string,
    _status: EvalCaseStatus,
  ): Promise<EvalCase | null> {
    throw new Error("not implemented");
  }
}

describe("EvalSnapshotService.capture", () => {
  it("prepares an immutable snapshot input without persisting it", async () => {
    const conversation: ConversationRecord = {
      id: "conv-prepare",
      workspaceId: "ws-1",
      agentId: null,
      agentName: null,
      agentInternalName: null,
      sourceChannel: null,
      sourceOrigin: null,
      channelContext: null,
      anonymousSessionId: null,
      verifiedCustomerId: null,
      entryPageUrl: null,
      title: null,
      createdAt: fixedDate,
      updatedAt: fixedDate,
    };
    const messages: MessageRecord[] = [
      {
        id: "u-prepare",
        conversationId: conversation.id,
        workspaceId: "ws-1",
        role: "user",
        content: "Prepare this",
        createdAt: fixedDate,
      },
      {
        id: "a-prepare",
        conversationId: conversation.id,
        workspaceId: "ws-1",
        role: "assistant",
        content: "Prepared answer",
        createdAt: fixedDate,
      },
    ];
    const repository = new CapturingEvalRepository();
    const service = new EvalSnapshotService(
      new StubConversationRepository(conversation),
      new StubMessageRepository(messages),
      new StubAgentRepository(null),
      new StubRetrievalDefaultsProvider(),
      createRetrievalSkillSettingsResolver(),
      repository,
    );

    const prepared = await service.prepare({
      workspaceId: "ws-1",
      conversationId: conversation.id,
      messageId: "a-prepare",
      capturedBy: "account-1",
    });

    expect(repository.lastCreateInput).toBeNull();
    expect(prepared).toMatchObject({
      workspaceId: "ws-1",
      sourceConversationId: conversation.id,
      sourceMessageId: "a-prepare",
      replayTarget: {
        userMessageId: "u-prepare",
        assistantMessageId: "a-prepare",
      },
      capturedBy: "account-1",
    });
  });

  it("records the replay target for the selected assistant message", async () => {
    const conversation: ConversationRecord = {
      id: "conv-target",
      workspaceId: "ws-1",
      agentId: null,
      agentName: null,
      agentInternalName: null,
      sourceChannel: null,
      sourceOrigin: null,
      channelContext: null,
      anonymousSessionId: null,
      verifiedCustomerId: null,
      entryPageUrl: null,
      title: null,
      createdAt: fixedDate,
      updatedAt: fixedDate,
    };
    const messages: MessageRecord[] = [
      { id: "u1", conversationId: conversation.id, workspaceId: "ws-1", role: "user", content: "First", createdAt: fixedDate },
      {
        id: "a1",
        conversationId: conversation.id,
        workspaceId: "ws-1",
        role: "assistant",
        content: "First answer",
        createdAt: fixedDate,
        metadata: {
          directiveFirings: ["intro-once"],
          groundingVerdict: "degraded",
          groundingProtocolVersion: 2,
          groundingDiagnostics: {
            parseStatus: "valid_v2",
            claimCount: 2,
            sourcedClaimCount: 1,
            unsourcedClaimCount: 1,
            invalidSourceCount: 0,
            assertionMismatch: false,
          },
        },
      },
      { id: "u2", conversationId: conversation.id, workspaceId: "ws-1", role: "user", content: "Second", createdAt: fixedDate },
      { id: "a2", conversationId: conversation.id, workspaceId: "ws-1", role: "assistant", content: "Second answer", createdAt: fixedDate },
    ];
    const service = new EvalSnapshotService(
      new StubConversationRepository(conversation),
      new StubMessageRepository(messages),
      new StubAgentRepository(null),
      new StubRetrievalDefaultsProvider(),
      createRetrievalSkillSettingsResolver(),
      new CapturingEvalRepository(),
    );

    const snapshot = await service.capture({
      workspaceId: "ws-1",
      conversationId: conversation.id,
      messageId: "a1",
      capturedBy: "account-1",
    });

    expect(snapshot.sourceMessageId).toBe("a1");
    expect(snapshot.replayTarget).toEqual({ userMessageId: "u1", assistantMessageId: "a1" });
    expect(snapshot.messages.map((message) => message.id)).toEqual(["u1", "a1"]);
    expect(snapshot.messages[1]?.groundingSummary).toMatchObject({
      protocolVersion: 2,
      verdict: "degraded",
      unsourcedClaimCount: 1,
    });
    expect(snapshot.messages[1]?.directiveFirings).toEqual(["intro-once"]);
  });

  it("records a user-only replay target when the selected message is the user turn", async () => {
    const conversation: ConversationRecord = {
      id: "conv-user-target",
      workspaceId: "ws-1",
      agentId: null,
      agentName: null,
      agentInternalName: null,
      sourceChannel: null,
      sourceOrigin: null,
      channelContext: null,
      anonymousSessionId: null,
      verifiedCustomerId: null,
      entryPageUrl: null,
      title: null,
      createdAt: fixedDate,
      updatedAt: fixedDate,
    };
    const messages: MessageRecord[] = [
      { id: "u1", conversationId: conversation.id, workspaceId: "ws-1", role: "user", content: "First", createdAt: fixedDate },
      { id: "a1", conversationId: conversation.id, workspaceId: "ws-1", role: "assistant", content: "First answer", createdAt: fixedDate },
      { id: "u2", conversationId: conversation.id, workspaceId: "ws-1", role: "user", content: "Second", createdAt: fixedDate },
    ];
    const service = new EvalSnapshotService(
      new StubConversationRepository(conversation),
      new StubMessageRepository(messages),
      new StubAgentRepository(null),
      new StubRetrievalDefaultsProvider(),
      createRetrievalSkillSettingsResolver(),
      new CapturingEvalRepository(),
    );

    const snapshot = await service.capture({
      workspaceId: "ws-1",
      conversationId: conversation.id,
      messageId: "u2",
      capturedBy: "account-1",
    });

    expect(snapshot.sourceMessageId).toBeNull();
    expect(snapshot.replayTarget).toEqual({ userMessageId: "u2", assistantMessageId: null });
    expect(snapshot.messages.map((message) => message.id)).toEqual(["u1", "a1", "u2"]);
  });

  it("stores the full internal agent config as the snapshot baseline", async () => {
    const originalAgent = agent();
    const conversation: ConversationRecord = {
      id: "conv-1",
      workspaceId: "ws-1",
      agentId: originalAgent.id,
      agentName: originalAgent.name,
      agentInternalName: null,
      sourceChannel: null,
      sourceOrigin: null,
      channelContext: null,
      anonymousSessionId: null,
      verifiedCustomerId: null,
      entryPageUrl: null,
      title: null,
      createdAt: fixedDate,
      updatedAt: fixedDate,
    };
    const messages: MessageRecord[] = [
      {
        id: "msg-1",
        conversationId: conversation.id,
        workspaceId: conversation.workspaceId,
        role: "user",
        content: "What is the policy?",
        createdAt: fixedDate,
      },
      {
        id: "msg-2",
        conversationId: conversation.id,
        workspaceId: conversation.workspaceId,
        role: "assistant",
        content: "Policy answer.",
        createdAt: fixedDate,
      },
    ];
    const repository = new CapturingEvalRepository();
    const externalSkills = {
      connections: {
        listByAgent: async () => [
          {
            id: "11111111-1111-4111-8111-111111111111",
            agentId: originalAgent.id,
            displayName: "Slack",
            serverUrl: "https://mcp.slack.example.com",
            authMethod: "access_token" as const,
            credentialCiphertext: "encrypted-token",
            encryptionKeyId: null,
            oauthClientCiphertext: null,
            oauthFlowCiphertext: null,
            status: "authorized" as const,
            createdAt: fixedDate,
            updatedAt: fixedDate,
          },
        ],
      },
      skillDefinitions: {
        listByAgent: async () => [
          {
            id: "22222222-2222-4222-8222-222222222222",
            agentId: originalAgent.id,
            connectionId: "11111111-1111-4111-8111-111111111111",
            skillName: "handoff_slack",
            toolName: "post_message",
            boundParams: { channel: "#support" },
            exposedParams: { message: {} },
            declaredOutcomes: null,
            outcomeMap: null,
            enabled: true,
            createdAt: fixedDate,
            updatedAt: fixedDate,
          },
        ],
      },
    } satisfies EvalSnapshotExternalSkillsPort;
    const service = new EvalSnapshotService(
      new StubConversationRepository(conversation),
      new StubMessageRepository(messages),
      new StubAgentRepository(originalAgent),
      new StubRetrievalDefaultsProvider(),
      createRetrievalSkillSettingsResolver(),
      repository,
      externalSkills,
    );

    const snapshot = await service.capture({
      workspaceId: "ws-1",
      conversationId: conversation.id,
      capturedBy: "account-1",
    });

    expect(snapshot.sourceAgentId).toBe(originalAgent.id);
    expect(snapshot.originalAgent).toBeNull();
    expect(snapshot.originalAgentConfig?.schemaVersion).toBe(3);
    expect(snapshot.originalAgentConfig?.name).toBe("Snapshot Bot");
    expect(snapshot.originalAgentConfig?.externalSkills).toEqual({
      connections: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          displayName: "Slack",
          serverUrl: "https://mcp.slack.example.com",
          authMethod: "access_token",
          hasCredential: true,
        },
      ],
      skills: [
        {
          skillName: "handoff_slack",
          connectionId: "11111111-1111-4111-8111-111111111111",
          toolName: "post_message",
          boundParams: { channel: "#support" },
          exposedParams: { message: {} },
          declaredOutcomes: null,
          outcomeMap: null,
          enabled: true,
        },
      ],
    });
    expect(snapshot.originalAgentConfig?.surfaceSettings.anonymousChat.token).toBe("anonymous-token");
    expect(snapshot.originalAgentConfig?.surfaceSettings.websiteEmbed.token).toBe("embed-token");
    expect(snapshot.originalAgentConfig?.skillSettings["retrieval.answer"]).toEqual({
      enabled: false,
      settings: {
        vectorTopK: 7,
        rerankEnabled: true,
        __agentRetrievalDefaults: {
          sourceScope: { mode: "selected", sourceIds: ["source-1", "source-2"] },
          suggestedQuestionsEnabled: false,
          citationDisplayEnabled: false,
          assistantLinkUtmEnabled: false,
        },
      },
    });
    expect(repository.lastCreateInput?.originalRetrievalSettings).toEqual(freezeRetrievalSettings({
      ...new StubRetrievalDefaultsProvider().settings,
      vectorTopK: 7,
      rerankEnabled: true,
    }));
  });

  it("captures system retrieval defaults when the conversation has no agent", async () => {
    const conversation: ConversationRecord = {
      id: "conv-1",
      workspaceId: "ws-1",
      agentId: null,
      agentName: null,
      agentInternalName: null,
      sourceChannel: null,
      sourceOrigin: null,
      channelContext: null,
      anonymousSessionId: null,
      verifiedCustomerId: null,
      entryPageUrl: null,
      title: null,
      createdAt: fixedDate,
      updatedAt: fixedDate,
    };
    const messages: MessageRecord[] = [
      {
        id: "msg-1",
        conversationId: conversation.id,
        workspaceId: conversation.workspaceId,
        role: "user",
        content: "What is the policy?",
        createdAt: fixedDate,
      },
      {
        id: "msg-2",
        conversationId: conversation.id,
        workspaceId: conversation.workspaceId,
        role: "assistant",
        content: "Policy answer.",
        createdAt: fixedDate,
      },
    ];
    const repository = new CapturingEvalRepository();
    const defaults = new StubRetrievalDefaultsProvider();
    const service = new EvalSnapshotService(
      new StubConversationRepository(conversation),
      new StubMessageRepository(messages),
      new StubAgentRepository(null),
      defaults,
      createRetrievalSkillSettingsResolver(),
      repository,
    );

    const snapshot = await service.capture({
      workspaceId: "ws-1",
      conversationId: conversation.id,
      capturedBy: "account-1",
    });

    expect(snapshot.sourceAgentId).toBeNull();
    expect(repository.lastCreateInput?.originalRetrievalSettings).toEqual(
      freezeRetrievalSettings(defaults.getDefaults("ws-1")),
    );
  });

  it("freezes the active routine position into the snapshot, stripping sessionId", async () => {
    const conversation: ConversationRecord = {
      id: "conv-routine",
      workspaceId: "ws-1",
      agentId: null,
      agentName: null,
      agentInternalName: null,
      sourceChannel: null,
      sourceOrigin: null,
      channelContext: null,
      anonymousSessionId: null,
      verifiedCustomerId: null,
      entryPageUrl: null,
      title: null,
      createdAt: fixedDate,
      updatedAt: fixedDate,
    };
    const messages: MessageRecord[] = [
      { id: "m1", conversationId: conversation.id, workspaceId: "ws-1", role: "user", content: "Hi", createdAt: fixedDate },
    ];
    const repository = new CapturingEvalRepository();
    const service = new EvalSnapshotService(
      new StubConversationRepository(conversation),
      new StubMessageRepository(messages),
      new StubAgentRepository(null),
      new StubRetrievalDefaultsProvider(),
      createRetrievalSkillSettingsResolver(),
      repository,
      undefined,
      {
        loadActive: async ({ sessionId }) => ({
          sessionId,
          routineId: "ask_email_on_interest",
          path: ["step_1_ask"],
          variables: { customer_email: "buyer@example.com" },
          attempts: { step_1_ask: 1 },
          status: "active",
        }),
      },
    );

    const snapshot = await service.capture({
      workspaceId: "ws-1",
      conversationId: conversation.id,
      capturedBy: "account-1",
    });

    expect(snapshot.originalRoutineState).toEqual({
      routineId: "ask_email_on_interest",
      path: ["step_1_ask"],
      variables: { customer_email: "buyer@example.com" },
      attempts: { step_1_ask: 1 },
      status: "active",
    });
  });

  it("freezes the rolling conversation summary (#866) onto the snapshot at capture time", async () => {
    const conversation: ConversationRecord = {
      id: "conv-summary",
      workspaceId: "ws-1",
      agentId: null,
      agentName: null,
      agentInternalName: null,
      sourceChannel: null,
      sourceOrigin: null,
      channelContext: null,
      anonymousSessionId: null,
      verifiedCustomerId: null,
      entryPageUrl: null,
      title: null,
      createdAt: fixedDate,
      updatedAt: fixedDate,
    };
    const messages: MessageRecord[] = [
      { id: "m1", conversationId: conversation.id, workspaceId: "ws-1", role: "user", content: "Hi", createdAt: fixedDate },
    ];
    const repository = new CapturingEvalRepository();
    const service = new EvalSnapshotService(
      new StubConversationRepository(conversation),
      new StubMessageRepository(messages),
      new StubAgentRepository(null),
      new StubRetrievalDefaultsProvider(),
      createRetrievalSkillSettingsResolver(),
      repository,
      undefined,
      undefined,
      {
        load: async ({ sessionId }) =>
          sessionId === conversation.id
            ? {
                summary: "The user booked the June retreat and paid the deposit.",
                coveredMessageCount: 12,
                coveredThrough: fixedDate,
              }
            : null,
      },
    );

    const snapshot = await service.capture({
      workspaceId: "ws-1",
      conversationId: conversation.id,
      capturedBy: "account-1",
    });

    expect(snapshot.conversationSummary).toBe(
      "The user booked the June retreat and paid the deposit.",
    );
    expect(repository.lastCreateInput?.conversationSummary).toBe(
      "The user booked the June retreat and paid the deposit.",
    );
  });

  it("omits the summary when the store has no row for the conversation", async () => {
    const conversation: ConversationRecord = {
      id: "conv-no-summary",
      workspaceId: "ws-1",
      agentId: null,
      agentName: null,
      agentInternalName: null,
      sourceChannel: null,
      sourceOrigin: null,
      channelContext: null,
      anonymousSessionId: null,
      verifiedCustomerId: null,
      entryPageUrl: null,
      title: null,
      createdAt: fixedDate,
      updatedAt: fixedDate,
    };
    const messages: MessageRecord[] = [
      { id: "m1", conversationId: conversation.id, workspaceId: "ws-1", role: "user", content: "Hi", createdAt: fixedDate },
    ];
    const repository = new CapturingEvalRepository();
    const service = new EvalSnapshotService(
      new StubConversationRepository(conversation),
      new StubMessageRepository(messages),
      new StubAgentRepository(null),
      new StubRetrievalDefaultsProvider(),
      createRetrievalSkillSettingsResolver(),
      repository,
      undefined,
      undefined,
      { load: async () => null },
    );

    const snapshot = await service.capture({
      workspaceId: "ws-1",
      conversationId: conversation.id,
      capturedBy: "account-1",
    });

    expect(snapshot.conversationSummary).toBeUndefined();
    expect(repository.lastCreateInput?.conversationSummary).toBeUndefined();
  });

  it("captures no summary when no summary store is wired (backward compatible)", async () => {
    const conversation: ConversationRecord = {
      id: "conv-legacy",
      workspaceId: "ws-1",
      agentId: null,
      agentName: null,
      agentInternalName: null,
      sourceChannel: null,
      sourceOrigin: null,
      channelContext: null,
      anonymousSessionId: null,
      verifiedCustomerId: null,
      entryPageUrl: null,
      title: null,
      createdAt: fixedDate,
      updatedAt: fixedDate,
    };
    const messages: MessageRecord[] = [
      { id: "m1", conversationId: conversation.id, workspaceId: "ws-1", role: "user", content: "Hi", createdAt: fixedDate },
    ];
    const repository = new CapturingEvalRepository();
    // Constructed without the summary-store dependency, exactly like a pre-#866 caller.
    const service = new EvalSnapshotService(
      new StubConversationRepository(conversation),
      new StubMessageRepository(messages),
      new StubAgentRepository(null),
      new StubRetrievalDefaultsProvider(),
      createRetrievalSkillSettingsResolver(),
      repository,
    );

    const snapshot = await service.capture({
      workspaceId: "ws-1",
      conversationId: conversation.id,
      capturedBy: "account-1",
    });

    expect(snapshot.conversationSummary).toBeUndefined();
    expect(repository.lastCreateInput?.conversationSummary).toBeUndefined();
  });

  it("prefers the per-turn pre-answer summary on an answered turn over a newer current row", async () => {
    const conversation: ConversationRecord = {
      id: "conv-answered",
      workspaceId: "ws-1",
      agentId: null,
      agentName: null,
      agentInternalName: null,
      sourceChannel: null,
      sourceOrigin: null,
      channelContext: null,
      anonymousSessionId: null,
      verifiedCustomerId: null,
      entryPageUrl: null,
      title: null,
      createdAt: fixedDate,
      updatedAt: fixedDate,
    };
    const userDate = new Date("2026-05-23T12:00:00.000Z");
    const assistantDate = new Date("2026-05-23T12:00:05.000Z");
    const messages: MessageRecord[] = [
      { id: "u1", conversationId: conversation.id, workspaceId: "ws-1", role: "user", content: "How big is the deposit?", createdAt: userDate },
      {
        id: "a1",
        conversationId: conversation.id,
        workspaceId: "ws-1",
        role: "assistant",
        content: "The deposit is $200.",
        createdAt: assistantDate,
        metadata: { conversationSummary: "User is asking about the deposit amount." },
      },
    ];
    const repository = new CapturingEvalRepository();
    const service = new EvalSnapshotService(
      new StubConversationRepository(conversation),
      new StubMessageRepository(messages),
      new StubAgentRepository(null),
      new StubRetrievalDefaultsProvider(),
      createRetrievalSkillSettingsResolver(),
      repository,
      undefined,
      undefined,
      {
        // Newer row already distills the answer — must be ignored for an answered turn.
        load: async () => ({
          summary: "The deposit is $200 and the user has now been told the amount.",
          coveredMessageCount: 5,
          coveredThrough: new Date("2026-05-23T12:01:00.000Z"),
        }),
      },
    );

    const snapshot = await service.capture({
      workspaceId: "ws-1",
      conversationId: conversation.id,
      messageId: "a1",
      capturedBy: "account-1",
    });

    expect(snapshot.conversationSummary).toBe("User is asking about the deposit amount.");
  });

  it("omits the summary when the answered turn recorded an explicit null, despite a current row", async () => {
    const conversation: ConversationRecord = {
      id: "conv-answered-null",
      workspaceId: "ws-1",
      agentId: null,
      agentName: null,
      agentInternalName: null,
      sourceChannel: null,
      sourceOrigin: null,
      channelContext: null,
      anonymousSessionId: null,
      verifiedCustomerId: null,
      entryPageUrl: null,
      title: null,
      createdAt: fixedDate,
      updatedAt: fixedDate,
    };
    const userDate = new Date("2026-05-23T12:00:00.000Z");
    const assistantDate = new Date("2026-05-23T12:00:05.000Z");
    const messages: MessageRecord[] = [
      { id: "u1", conversationId: conversation.id, workspaceId: "ws-1", role: "user", content: "Hi", createdAt: userDate },
      {
        id: "a1",
        conversationId: conversation.id,
        workspaceId: "ws-1",
        role: "assistant",
        content: "Hello!",
        createdAt: assistantDate,
        metadata: { conversationSummary: null },
      },
    ];
    const repository = new CapturingEvalRepository();
    const service = new EvalSnapshotService(
      new StubConversationRepository(conversation),
      new StubMessageRepository(messages),
      new StubAgentRepository(null),
      new StubRetrievalDefaultsProvider(),
      createRetrievalSkillSettingsResolver(),
      repository,
      undefined,
      undefined,
      {
        load: async () => ({
          summary: "A current row that must not leak into an explicit-null turn.",
          coveredMessageCount: 3,
          coveredThrough: new Date("2026-05-23T11:59:00.000Z"),
        }),
      },
    );

    const snapshot = await service.capture({
      workspaceId: "ws-1",
      conversationId: conversation.id,
      messageId: "a1",
      capturedBy: "account-1",
    });

    expect(snapshot.conversationSummary).toBeUndefined();
    expect(repository.lastCreateInput?.conversationSummary).toBeUndefined();
  });

  it("falls back to the current row for a legacy answered turn only when it predates the replayed user message", async () => {
    const conversation: ConversationRecord = {
      id: "conv-legacy-before",
      workspaceId: "ws-1",
      agentId: null,
      agentName: null,
      agentInternalName: null,
      sourceChannel: null,
      sourceOrigin: null,
      channelContext: null,
      anonymousSessionId: null,
      verifiedCustomerId: null,
      entryPageUrl: null,
      title: null,
      createdAt: fixedDate,
      updatedAt: fixedDate,
    };
    const userDate = new Date("2026-05-23T12:00:00.000Z");
    const assistantDate = new Date("2026-05-23T12:00:05.000Z");
    const messages: MessageRecord[] = [
      { id: "u1", conversationId: conversation.id, workspaceId: "ws-1", role: "user", content: "What's next?", createdAt: userDate },
      // Legacy pre-feature assistant message: metadata carries no conversationSummary key.
      { id: "a1", conversationId: conversation.id, workspaceId: "ws-1", role: "assistant", content: "Here is the plan.", createdAt: assistantDate, metadata: {} },
    ];
    const repository = new CapturingEvalRepository();
    const service = new EvalSnapshotService(
      new StubConversationRepository(conversation),
      new StubMessageRepository(messages),
      new StubAgentRepository(null),
      new StubRetrievalDefaultsProvider(),
      createRetrievalSkillSettingsResolver(),
      repository,
      undefined,
      undefined,
      {
        load: async () => ({
          summary: "Context assembled before the replayed user turn.",
          coveredMessageCount: 4,
          coveredThrough: new Date("2026-05-23T11:59:00.000Z"),
        }),
      },
    );

    const snapshot = await service.capture({
      workspaceId: "ws-1",
      conversationId: conversation.id,
      messageId: "a1",
      capturedBy: "account-1",
    });

    expect(snapshot.conversationSummary).toBe("Context assembled before the replayed user turn.");
  });

  it("omits the fallback summary for a legacy answered turn when the row covers the replayed user message", async () => {
    const conversation: ConversationRecord = {
      id: "conv-legacy-after",
      workspaceId: "ws-1",
      agentId: null,
      agentName: null,
      agentInternalName: null,
      sourceChannel: null,
      sourceOrigin: null,
      channelContext: null,
      anonymousSessionId: null,
      verifiedCustomerId: null,
      entryPageUrl: null,
      title: null,
      createdAt: fixedDate,
      updatedAt: fixedDate,
    };
    const userDate = new Date("2026-05-23T12:00:00.000Z");
    const assistantDate = new Date("2026-05-23T12:00:05.000Z");
    const messages: MessageRecord[] = [
      { id: "u1", conversationId: conversation.id, workspaceId: "ws-1", role: "user", content: "What's next?", createdAt: userDate },
      { id: "a1", conversationId: conversation.id, workspaceId: "ws-1", role: "assistant", content: "Here is the plan.", createdAt: assistantDate, metadata: {} },
    ];
    const repository = new CapturingEvalRepository();
    const service = new EvalSnapshotService(
      new StubConversationRepository(conversation),
      new StubMessageRepository(messages),
      new StubAgentRepository(null),
      new StubRetrievalDefaultsProvider(),
      createRetrievalSkillSettingsResolver(),
      repository,
      undefined,
      undefined,
      {
        // Watermark equals the replayed user message createdAt: not strictly before, so
        // the row may already reflect that turn (or its answer) — omit.
        load: async () => ({
          summary: "A row that already covers the replayed user turn.",
          coveredMessageCount: 6,
          coveredThrough: userDate,
        }),
      },
    );

    const snapshot = await service.capture({
      workspaceId: "ws-1",
      conversationId: conversation.id,
      messageId: "a1",
      capturedBy: "account-1",
    });

    expect(snapshot.conversationSummary).toBeUndefined();
    expect(repository.lastCreateInput?.conversationSummary).toBeUndefined();
  });

  it("captures a null routine state when no routine is active", async () => {
    const conversation: ConversationRecord = {
      id: "conv-no-routine",
      workspaceId: "ws-1",
      agentId: null,
      agentName: null,
      agentInternalName: null,
      sourceChannel: null,
      sourceOrigin: null,
      channelContext: null,
      anonymousSessionId: null,
      verifiedCustomerId: null,
      entryPageUrl: null,
      title: null,
      createdAt: fixedDate,
      updatedAt: fixedDate,
    };
    const messages: MessageRecord[] = [
      { id: "m1", conversationId: conversation.id, workspaceId: "ws-1", role: "user", content: "Hi", createdAt: fixedDate },
    ];
    const service = new EvalSnapshotService(
      new StubConversationRepository(conversation),
      new StubMessageRepository(messages),
      new StubAgentRepository(null),
      new StubRetrievalDefaultsProvider(),
      createRetrievalSkillSettingsResolver(),
      new CapturingEvalRepository(),
      undefined,
      { loadActive: async () => null },
    );

    const snapshot = await service.capture({
      workspaceId: "ws-1",
      conversationId: conversation.id,
      capturedBy: "account-1",
    });

    expect(snapshot.originalRoutineState).toBeNull();
  });
});
