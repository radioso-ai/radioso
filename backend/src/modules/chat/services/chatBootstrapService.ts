import { createHash, randomUUID } from "node:crypto";

import type { AuditService } from "../../audit/contracts/index.js";
import type { WorkspaceRepositoryPort } from "../../../db/repositories/workspaceRepository.js";
import type { AgentService } from "../../agents/public.js";
import { isAgentBootstrapActive } from "../../agents/public.js";
import type { BootstrapGreetingCacheRepositoryPort } from "../../../db/repositories/bootstrapGreetingCacheRepository.js";
import { renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import type { ChatGateway } from "../contracts/chatGateway.js";
import type { ChatBootstrapResponse } from "../types/chatResponses.js";
import type { AssistantPageContext } from "../types/assistantApi.js";
import type { ConversationChannelContext } from "@radioso/conversation-contract";
import {
  buildPublicAssistantIdentityLines,
} from "../../settings/contracts/assistantBootstrap.js";
import { assertInteractiveAssistantWorkflow } from "./chatExecutionPolicy.js";
import { isValidLocaleHint, resolveChatLocale } from "./chatLocale.js";
import { NoopUsageLimitPolicy, type UsageLimitPolicy } from "../../../shared/domain/usageLimitPolicy.js";
import {
  NoopProductAnalyticsService,
  type ProductAnalyticsPort,
} from "../../../shared/analytics/productAnalyticsService.js";

const emptyChatResponse = (answer: string): ChatBootstrapResponse => ({
  route: {
    type: "direct",
    reason: "conversation_start",
  },
  answer,
  citations: [],
  answerSegments: answer ? [{ text: answer }] : [],
  activitySummary: {
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
  activityTrace: {
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
    private readonly chatGateway: ChatGateway,
    private readonly auditService: AuditService,
    private readonly usageLimitPolicy: UsageLimitPolicy = new NoopUsageLimitPolicy(),
    private readonly productAnalyticsService: ProductAnalyticsPort = new NoopProductAnalyticsService(),
    private readonly agentService: Pick<AgentService, "resolve">,
  ) {}

  async startConversation(input: {
    workspaceId: string;
    agentId?: string | null;
    accountId?: string;
    sourceChannel?: string | null;
    channelContext?: ConversationChannelContext | null;
    chatSessionId?: string | null;
    sourceOrigin?: string | null;
    userExpectedLocale?: string | null;
    pageContext?: AssistantPageContext | null;
  }): Promise<ChatBootstrapResponse | null> {
    const workflowPolicy = assertInteractiveAssistantWorkflow("chat.bootstrap");
    const workspace = await this.workspaceRepository.findById(input.workspaceId);
    if (!workspace) {
      return null;
    }
    const agent = await this.agentService.resolve(input.workspaceId, input.agentId);
    if (!isAgentBootstrapActive({
      name: agent.name,
      proactiveGreetingEnabled: agent.proactiveGreetingEnabled,
    })) {
      return null;
    }

    const requestedLocale =
      isValidLocaleHint(input.userExpectedLocale)
        ? input.userExpectedLocale
        : isValidLocaleHint(input.pageContext?.pageLocale)
          ? input.pageContext?.pageLocale
          : input.pageContext?.browserLocale;
    const localeUsed = resolveChatLocale({
      userExpectedLocale: requestedLocale,
      assistantDefaultLocale: agent.assistantDefaultLocale,
    });
    const fingerprint = createBootstrapFingerprint({
      assistantName: agent.name,
      customInstruction: agent.customInstruction,
      assistantDefaultLocale: agent.assistantDefaultLocale,
      localeUsed,
    });

    let usageReservation: Awaited<ReturnType<UsageLimitPolicy["reserveAnswer"]>> | null = null;
    try {
      const cachedGreeting = await this.bootstrapGreetingCacheRepository.findByWorkspaceAgentAndFingerprint(
        input.workspaceId,
        agent.id,
        fingerprint,
      );
      usageReservation = cachedGreeting
        ? null
        : await this.usageLimitPolicy.reserveAnswer({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            surface: input.sourceChannel ?? "chat.bootstrap",
          });
      const normalizedAnswer = cachedGreeting?.greetingText
        ?? (await this.chatGateway.answer({
            query: "",
            history: [],
            usageContext: {
              accountId: input.accountId ?? null,
              workspaceId: input.workspaceId,
              requestId: `bootstrap:${agent.id}:${fingerprint}`,
              surface: "assistant",
              operation: "bootstrap_greeting",
              attemptKey: fingerprint,
            },
            prompt: buildBootstrapPrompt({
              assistantName: agent.name,
              customInstruction: agent.customInstruction,
              localeUsed,
            }),
        })).trim();
      if (!normalizedAnswer) {
        await usageReservation?.release();
        return null;
      }

      const greetingRecord = cachedGreeting
        ?? await this.bootstrapGreetingCacheRepository.save({
          workspaceId: input.workspaceId,
          agentId: agent.id,
          fingerprint,
          localeUsed,
          greetingText: normalizedAnswer,
        });

      await this.auditService.record({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        eventType: "chat.bootstrap",
        eventStatus: "success",
        metadata: {
          workflow: workflowPolicy.workflow,
          executionClass: workflowPolicy.executionClass,
          sourceChannel: input.sourceChannel ?? null,
          sourceOrigin: input.sourceOrigin ?? null,
          localeUsed,
          cacheHit: Boolean(cachedGreeting),
          fingerprint,
          proactiveGreetingEnabled: true,
        },
      });
      try {
        await this.productAnalyticsService.track({
          eventName: "chat.started",
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          actorType: input.accountId ? "authenticated_user" : "anonymous_user",
          subjectType: "workspace",
          subjectId: input.workspaceId,
          properties: {
            sourceChannel: input.sourceChannel ?? null,
            sourceOrigin: input.sourceOrigin ?? null,
            localeUsed,
            cacheHit: Boolean(cachedGreeting),
            proactiveGreetingEnabled: true,
          },
          source: "backend",
        });
      } catch {
        // Analytics fan-out must not affect opening the chat.
      }
      await usageReservation?.commit();

      return {
        ...emptyChatResponse(normalizedAnswer),
        ...(agent ? { agentId: agent.id, agentName: agent.name } : {}),
        bootstrapGreetingId: greetingRecord.id,
      };
    } catch (error) {
      await usageReservation?.release();
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "usage_limit_exceeded"
      ) {
        throw error;
      }
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
