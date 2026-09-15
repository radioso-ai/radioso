import { createHash, randomUUID } from "node:crypto";

import type { AuditService } from "../../audit/contracts/index.js";
import type { WorkspaceRepositoryPort } from "../../../db/repositories/workspaceRepository.js";
import type { AgentService, AgentRevisionRuntimeResolver, ConversationAgent } from "../../agents/public.js";
import { DEFAULT_AGENT_LOCALE_FALLBACK, isAgentBootstrapActive, readAgentRevisionGreeting } from "../../agents/public.js";
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
import { AppError } from "../../../shared/domain/errors.js";
import {
  resolveExactContent,
  type ExactContentChipResolution,
  type ExactContentItem,
} from "../../../shared/domain/exactContent.js";

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
    /**
     * Optional: reads the same revision selection a normal turn uses (spec 1150 F13).
     * Absent only in deployments/tests that never wired revision publishing into
     * bootstrap — bootstrap then behaves as if no agent has ever published exact
     * greeting content, i.e. Automatic only, exactly today's behavior.
     */
    private readonly agentRevisionRuntimeResolver?: Pick<AgentRevisionRuntimeResolver, "resolveNew" | "resolvePinned">,
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
    /** Trusted internal callers may supply an already-resolved immutable agent. */
    agentOverride?: ConversationAgent;
    revisionId?: string;
  }): Promise<ChatBootstrapResponse | null> {
    const workflowPolicy = assertInteractiveAssistantWorkflow("chat.bootstrap");
    const workspace = await this.workspaceRepository.findById(input.workspaceId);
    if (!workspace) {
      return null;
    }
    const agent = input.agentOverride ?? await this.agentService.resolve(input.workspaceId, input.agentId);
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

    const revisionGreeting = await this.resolveRevisionGreeting({
      workspaceId: input.workspaceId,
      agent,
      trustedRevision: Boolean(input.agentOverride && input.revisionId),
      revisionId: input.revisionId,
    });
    if (revisionGreeting?.greeting.exactWordsEnabled && revisionGreeting.greeting.exactContent) {
      // Exact mode never reserves usage and never calls the model (spec 1150 F5). It
      // still writes to bootstrap_greeting_cache — not as an LLM-avoidance cache (there
      // is no LLM call to avoid), but as the delivery record of what this visitor was
      // actually shown, so first-turn promotion can carry the same text and chips into
      // history without re-resolving against whatever the revision looks like by then.
      return this.deliverExactGreeting({
        startInput: input,
        agent,
        revisionId: revisionGreeting.revisionId,
        requestedLocale: requestedLocale ?? null,
        workflowPolicy,
        exactContent: revisionGreeting.greeting.exactContent,
      });
    }

    const fingerprint = createBootstrapFingerprint({
      assistantName: agent.name,
      customInstruction: agent.customInstruction,
      assistantDefaultLocale: agent.assistantDefaultLocale,
      localeUsed,
      revisionId: input.revisionId,
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
            usage: "greeting",
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
          greetingMode: "automatic",
          requestedLocale: requestedLocale ?? null,
          resolvedLocale: localeUsed,
          fallbackApplied: Boolean(requestedLocale) && localeUsed !== requestedLocale,
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
          greetingMode: "automatic",
          errorMessage: error instanceof Error ? error.message : "bootstrap generation failed",
        },
      });
      return null;
    }
  }

  /**
   * The same revision selection a normal turn uses for this conversation (spec 1150
   * F13): the published revision for a production start, or the pinned candidate for
   * a trusted test-execution bootstrap (the sole caller that supplies both
   * `agentOverride` and `revisionId`, already established by
   * `TrustedTestExecutionRunnerAdapter`). Returns `null` when no resolver is wired, or
   * when the agent has never published a revision — both leave Automatic as the only
   * option, exactly today's behavior; this never becomes a second way of picking a
   * revision.
   */
  private async resolveRevisionGreeting(input: {
    workspaceId: string;
    agent: ConversationAgent;
    trustedRevision: boolean;
    revisionId?: string;
  }): Promise<{ revisionId: string; greeting: ReturnType<typeof readAgentRevisionGreeting> } | null> {
    if (!this.agentRevisionRuntimeResolver) {
      return null;
    }
    try {
      const resolved = input.trustedRevision && input.revisionId
        ? await this.agentRevisionRuntimeResolver.resolvePinned({
            workspaceId: input.workspaceId,
            agent: input.agent,
            revisionId: input.revisionId,
            allowCandidate: true,
          })
        : await this.agentRevisionRuntimeResolver.resolveNew({
            workspaceId: input.workspaceId,
            agent: input.agent,
          });
      return { revisionId: resolved.revision.id, greeting: readAgentRevisionGreeting(resolved.revision.snapshot) };
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Exact mode's whole delivery: resolve the authored variant/chips for the
   * requested locale and either persist+return them verbatim (FR-003) or fall
   * through to the channel's existing unavailable/no-greeting outcome with no
   * synthetic text or chips and no model fallback (FR-011).
   */
  private async deliverExactGreeting(input: {
    startInput: Parameters<ChatBootstrapService["startConversation"]>[0];
    agent: ConversationAgent;
    revisionId: string;
    requestedLocale: string | null;
    workflowPolicy: ReturnType<typeof assertInteractiveAssistantWorkflow>;
    exactContent: ExactContentItem;
  }): Promise<ChatBootstrapResponse | null> {
    const { startInput, agent, revisionId, requestedLocale, workflowPolicy, exactContent } = input;
    const outcome = resolveExactContent(exactContent, {
      requestedLocale,
      agentDefaultLocale: agent.assistantDefaultLocale ?? DEFAULT_AGENT_LOCALE_FALLBACK,
      references: new Map(),
    });

    if (outcome.kind !== "resolved") {
      await this.auditService.record({
        accountId: startInput.accountId,
        workspaceId: startInput.workspaceId,
        eventType: "chat.bootstrap",
        eventStatus: "failure",
        metadata: {
          workflow: workflowPolicy.workflow,
          executionClass: workflowPolicy.executionClass,
          sourceChannel: startInput.sourceChannel ?? null,
          sourceOrigin: startInput.sourceOrigin ?? null,
          greetingMode: "exact",
          requestedLocale,
          reasonCode: outcome.reason,
        },
      });
      return null;
    }

    const suggestions = outcome.chips.map((chip) => ({
      id: chip.id,
      text: chip.label,
      kind: "authored",
      action: { kind: "ask_followup" as const },
    }));
    const fingerprint = createExactGreetingFingerprint({
      revisionId,
      resolvedLocale: outcome.locale,
      body: outcome.body,
      chips: outcome.chips,
    });
    const existingGreeting = await this.bootstrapGreetingCacheRepository.findByWorkspaceAgentAndFingerprint(
      startInput.workspaceId,
      agent.id,
      fingerprint,
    );
    const greetingRecord = existingGreeting
      ?? await this.bootstrapGreetingCacheRepository.save({
        workspaceId: startInput.workspaceId,
        agentId: agent.id,
        fingerprint,
        localeUsed: outcome.locale,
        greetingText: outcome.body,
        suggestions,
      });

    await this.auditService.record({
      accountId: startInput.accountId,
      workspaceId: startInput.workspaceId,
      eventType: "chat.bootstrap",
      eventStatus: "success",
      metadata: {
        workflow: workflowPolicy.workflow,
        executionClass: workflowPolicy.executionClass,
        sourceChannel: startInput.sourceChannel ?? null,
        sourceOrigin: startInput.sourceOrigin ?? null,
        greetingMode: "exact",
        requestedLocale,
        resolvedLocale: outcome.locale,
        fallbackApplied: outcome.fallbackApplied,
        cacheHit: Boolean(existingGreeting),
        fingerprint,
        proactiveGreetingEnabled: true,
      },
    });
    try {
      await this.productAnalyticsService.track({
        eventName: "chat.started",
        workspaceId: startInput.workspaceId,
        accountId: startInput.accountId,
        actorType: startInput.accountId ? "authenticated_user" : "anonymous_user",
        subjectType: "workspace",
        subjectId: startInput.workspaceId,
        properties: {
          sourceChannel: startInput.sourceChannel ?? null,
          sourceOrigin: startInput.sourceOrigin ?? null,
          localeUsed: outcome.locale,
          cacheHit: false,
          proactiveGreetingEnabled: true,
        },
        source: "backend",
      });
    } catch {
      // Analytics fan-out must not affect opening the chat.
    }

    return {
      ...emptyChatResponse(outcome.body),
      ...(agent ? { agentId: agent.id, agentName: agent.name } : {}),
      suggestions,
      bootstrapGreetingId: greetingRecord.id,
    };
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
  revisionId?: string;
}): string =>
  createHash("sha256")
    .update(JSON.stringify({
      assistantName: input.assistantName,
      customInstruction: input.customInstruction,
      assistantDefaultLocale: input.assistantDefaultLocale,
      localeUsed: input.localeUsed,
      revisionId: input.revisionId ?? null,
    }))
    .digest("hex");

/**
 * Exact content's delivery-record key (spec 1150 F13/FR-015): the revision, resolved
 * locale, and the exact text/chips a visitor was shown. Deterministic so a second
 * bootstrap for the same revision/locale — before the revision changes again — reuses
 * the same row instead of writing a duplicate, matching the automatic fingerprint's
 * de-dupe behavior even though nothing here is memoized to avoid an LLM call.
 */
const createExactGreetingFingerprint = (input: {
  revisionId: string;
  resolvedLocale: string;
  body: string;
  chips: readonly ExactContentChipResolution[];
}): string =>
  createHash("sha256")
    .update(JSON.stringify({
      revisionId: input.revisionId,
      resolvedLocale: input.resolvedLocale,
      body: input.body,
      chips: input.chips,
    }))
    .digest("hex");
