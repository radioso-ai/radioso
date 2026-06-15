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

  async touch(): Promise<void> {}
}

class StubMessageRepository implements MessageRepositoryPort {
  constructor(private readonly messages: MessageRecord[]) {}

  async listByConversationId(workspaceId: string, conversationId: string): Promise<MessageRecord[]> {
    return this.messages.filter((message) =>
      message.workspaceId === workspaceId && message.conversationId === conversationId);
  }

  async listRecentByConversationId(): Promise<MessageRecord[]> {
    throw new Error("not implemented");
  }

  async listWindowByConversationId(): Promise<{ messages: MessageRecord[]; total: number; nextCursor: string | null; hasMore: boolean }> {
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
      requiredCapabilities: input.requiredCapabilities ?? [],
      dependsOn: input.dependsOn ?? [],
      excludes: input.excludes ?? [],
      routes: input.routes ?? [],
      tags: input.tags ?? [],
      description: input.description ?? null,
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
      requiredCapabilities: input.requiredCapabilities ?? [],
      dependsOn: input.dependsOn ?? [],
      excludes: input.excludes ?? [],
      routes: input.routes ?? [],
      tags: input.tags ?? [],
      description: input.description ?? null,
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

  async updateCaseAssertions(): Promise<EvalCase> {
    throw new Error("not implemented");
  }

  async updateCaseName(): Promise<EvalCase> {
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
  ): Promise<EvalCase> {
    throw new Error("not implemented");
  }
}

describe("EvalSnapshotService.capture", () => {
  it("stores the full internal agent config as the snapshot baseline", async () => {
    const originalAgent = agent();
    const conversation: ConversationRecord = {
      id: "conv-1",
      workspaceId: "ws-1",
      agentId: originalAgent.id,
      agentName: originalAgent.name,
      sourceChannel: null,
      sourceOrigin: null,
      anonymousSessionId: null,
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
      sourceChannel: null,
      sourceOrigin: null,
      anonymousSessionId: null,
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
});
