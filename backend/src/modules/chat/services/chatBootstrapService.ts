import { createHash, randomUUID } from "node:crypto";

import type { AuditService } from "../../audit/services/auditService.js";
import type { WorkspaceRepositoryPort } from "../../../db/repositories/workspaceRepository.js";
import type { BootstrapGreetingCacheRepositoryPort } from "../../../db/repositories/bootstrapGreetingCacheRepository.js";
import type { ConversationRepositoryPort } from "../../../db/repositories/conversationRepository.js";
import type { RetrievalSettingsService } from "../../settings/services/retrievalSettingsService.js";
import { renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import type { ChatGateway } from "./chatService.js";
import type { ChatResponse } from "../types/chatResponses.js";
import {
  buildPublicAssistantIdentityLines,
  isAssistantBootstrapActive,
} from "../../settings/domain/assistantBootstrapSettings.js";
import { DEFAULT_CONVERSATION_MODE } from "../../settings/domain/retrievalSettings.js";
import { assertInteractiveAssistantWorkflow } from "./chatExecutionPolicy.js";
import { resolveChatLocale } from "./chatLocale.js";

const emptyChatResponse = (conversationId: string, answer: string): ChatResponse => ({
  conversationId,
  route: {
    type: "direct",
    reason: "conversation_start",
  },
  answer,
  citations: [],
  answerSegments: answer ? [{ text: answer }] : [],
  conversationMode: DEFAULT_CONVERSATION_MODE,
  conversationModeMetadata: {
    conversationMode: DEFAULT_CONVERSATION_MODE,
    brevityOverrideApplied: false,
    expansionApplied: false,
    expansionKind: "none",
    suggestionCount: 0,
    followUpQuestionApplied: false,
  },
  retrievalInfo: {
    candidateCounts: {
      semantic: 0,
      lexical: 0,
      merged: 0,
      final: 0,
    },
    fallbackApplied: false,
    rerankStatus: "skipped",
    retrievalSkipped: true,
    rewrite: {
      status: "skipped",
      eligible: false,
      ran: false,
      materialDisagreement: false,
    },
  },
  retrievalTrace: {
    traceId: `bootstrap-${randomUUID()}`,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    totalDurationMs: 0,
    stages: [],
    links: [],
  },
});

export class ChatBootstrapService {
  constructor(
    private readonly workspaceRepository: WorkspaceRepositoryPort,
    private readonly bootstrapGreetingCacheRepository: BootstrapGreetingCacheRepositoryPort,
    private readonly conversationRepository: ConversationRepositoryPort,
    private readonly chatGateway: ChatGateway,
    private readonly auditService: AuditService,
    private readonly retrievalSettingsService: Pick<RetrievalSettingsService, "getForWorkspace">,
  ) {}

  async startConversation(input: {
    workspaceId: string;
    accountId?: string;
    sourceChannel?: string | null;
    anonymousSessionId?: string | null;
    sourceOrigin?: string | null;
    userExpectedLocale?: string | null;
  }): Promise<ChatResponse | null> {
    const workflowPolicy = assertInteractiveAssistantWorkflow("chat.bootstrap");
    const workspace = await this.workspaceRepository.findById(input.workspaceId);
    if (!workspace || !isAssistantBootstrapActive(workspace)) {
      return null;
    }
    const retrievalSettings = await this.retrievalSettingsService.getForWorkspace(input.workspaceId);

    const localeUsed = resolveChatLocale({
      userExpectedLocale: input.userExpectedLocale,
      assistantDefaultLocale: workspace.assistantDefaultLocale,
    });
    const fingerprint = createBootstrapFingerprint({
      assistantName: workspace.assistantName,
      customInstruction: retrievalSettings.customInstruction,
      assistantDefaultLocale: workspace.assistantDefaultLocale,
      localeUsed,
    });

    try {
      const cachedGreeting = await this.bootstrapGreetingCacheRepository.findByWorkspaceAndFingerprint(
        input.workspaceId,
        fingerprint,
      );
      const normalizedAnswer = cachedGreeting?.greetingText
        ?? (await this.chatGateway.answer({
          query: "",
          history: [],
          prompt: buildBootstrapPrompt({
            assistantName: workspace.assistantName,
            customInstruction: retrievalSettings.customInstruction,
            localeUsed,
          }),
        })).trim();
      if (!normalizedAnswer) {
        return null;
      }

      if (!cachedGreeting) {
        await this.bootstrapGreetingCacheRepository.save({
          workspaceId: input.workspaceId,
          fingerprint,
          localeUsed,
          greetingText: normalizedAnswer,
        });
      }

      const { conversation } = await this.conversationRepository.createWithInitialAssistantMessage({
        workspaceId: input.workspaceId,
        sourceChannel: input.sourceChannel ?? null,
        anonymousSessionId: input.anonymousSessionId ?? null,
        sourceOrigin: input.sourceOrigin ?? null,
        content: normalizedAnswer,
      });

      await this.auditService.record({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        eventType: "chat.bootstrap",
        eventStatus: "success",
        metadata: {
          workflow: workflowPolicy.workflow,
          executionClass: workflowPolicy.executionClass,
          conversationId: conversation.id,
          sourceChannel: input.sourceChannel ?? null,
          sourceOrigin: input.sourceOrigin ?? null,
          localeUsed,
          cacheHit: Boolean(cachedGreeting),
          fingerprint,
          proactiveGreetingEnabled: true,
        },
      });

      return emptyChatResponse(conversation.id, normalizedAnswer);
    } catch (error) {
      await this.auditService.record({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        eventType: "chat.bootstrap",
        eventStatus: "failure",
        metadata: {
          workflow: workflowPolicy.workflow,
          executionClass: workflowPolicy.executionClass,
          sourceChannel: input.sourceChannel ?? null,
          sourceOrigin: input.sourceOrigin ?? null,
          localeUsed,
          fingerprint,
          errorMessage: error instanceof Error ? error.message : "bootstrap generation failed",
        },
      });
      return null;
    }
  }
}

const buildBootstrapPrompt = (input: {
  assistantName: string;
  customInstruction: string;
  localeUsed: string | null;
}): string => {
  const localeInstruction = input.localeUsed
    ? `Write the greeting in locale ${input.localeUsed}.`
    : "Write the greeting in the best available language for the workspace.";
  const identityLines = buildPublicAssistantIdentityLines({
    assistantName: input.assistantName,
  });
  const customInstruction = input.customInstruction.trim()
    ? `Answer instruction: ${input.customInstruction.trim()}`
    : "";

  return renderPromptTemplate("chat/bootstrap-greeting.md", {
    locale_instruction: localeInstruction,
    identity_lines: [...identityLines, customInstruction].filter(Boolean).join("\n"),
  });
};

const createBootstrapFingerprint = (input: {
  assistantName: string;
  customInstruction: string;
  assistantDefaultLocale: string | null;
  localeUsed: string | null;
}): string =>
  createHash("sha256")
    .update(JSON.stringify({
      assistantName: input.assistantName,
      customInstruction: input.customInstruction,
      assistantDefaultLocale: input.assistantDefaultLocale,
      localeUsed: input.localeUsed,
    }))
    .digest("hex");
