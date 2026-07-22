import { randomUUID } from "node:crypto";

import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import { CHAT_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { ModelCallUsageContext } from "../../../shared/domain/modelCallUsageContext.js";
import { normalizeLlmClassifierLabel } from "../../../shared/domain/llmClassifierFields.js";
import type { ResponseIdentity } from "../../../shared/domain/responseIdentity.js";
import type { LlmCapabilityResolveInput } from "../../../shared/infra/llm/workspaceContext.js";
import type { ModelInferencePipeline } from "../../../shared/infra/llm/modelInferencePipeline.js";
import { renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import type { ChatGateway } from "../contracts/chatGateway.js";

export interface TurnRouting {
  route: "retrieval" | "direct";
  framing: {
    intentTopic?: string;
    inScopeRequest?: string;
    outsideScopeRequest?: string;
    isIdentityQuestion: boolean;
  };
}

export interface TurnRouterInput {
  query: string;
  history: MessageRecord[];
  responseIdentity?: ResponseIdentity | null;
  customInstruction?: string;
  workspaceContext?: LlmCapabilityResolveInput;
  usageContext?: Omit<ModelCallUsageContext, "operation">;
}

export interface TurnRouter {
  classify(input: TurnRouterInput): Promise<TurnRouting>;
}

export interface TurnRouterGatewayInput {
  query: string;
  contextMessages: MessageRecord[];
  workspaceContext?: LlmCapabilityResolveInput;
  usageContext: ModelCallUsageContext;
}

export interface TurnRouterGatewayResult {
  route?: string;
  isIdentityQuestion?: boolean;
  intentTopic?: string | null;
  inScopeRequest?: string | null;
  outsideScopeRequest?: string | null;
}

export interface TurnRouterGateway {
  classify(input: TurnRouterGatewayInput): Promise<TurnRouterGatewayResult>;
}

export const buildTurnRouterPrompt = (input: {
  context: string;
  query: string;
}): string =>
  renderPromptTemplate("chat/turn-router.md", {
    context_section: input.context || "No prior context",
    query: input.query,
  });

const formatConversationContext = (messages: MessageRecord[]): string =>
  messages
    .map((message) =>
      `${message.role.toUpperCase()}: ${message.content}${
        message.role === "user" ? " [authoritative for grounding]" : " [non-authoritative context]"
      }`,
    )
    .join("\n");

export const parseTurnRouting = (raw: string): TurnRouterGatewayResult => {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const parsed = JSON.parse(trimmed) as Record<string, unknown>;
  return {
    route: typeof parsed.route === "string" ? parsed.route : undefined,
    isIdentityQuestion: typeof parsed.isIdentityQuestion === "boolean" ? parsed.isIdentityQuestion : false,
    intentTopic: typeof parsed.intentTopic === "string" ? parsed.intentTopic : null,
    inScopeRequest: typeof parsed.inScopeRequest === "string" ? parsed.inScopeRequest : null,
    outsideScopeRequest: typeof parsed.outsideScopeRequest === "string" ? parsed.outsideScopeRequest : null,
  };
};

export class ModelTurnRouterGateway implements TurnRouterGateway {
  constructor(private readonly inference: ModelInferencePipeline) {}

  async classify(input: TurnRouterGatewayInput): Promise<TurnRouterGatewayResult> {
    const { text } = await this.inference.complete({
      operation: input.usageContext,
      prompt: buildTurnRouterPrompt({
        context: formatConversationContext(input.contextMessages),
        query: input.query,
      }),
      // Router is a small structured classifier. This adds a serial LLM call on
      // retrieval turns but lets non-retrieval turns skip the heavier rewrite.
      reasoningEffort: CHAT_BEHAVIOR.intentRouting.reasoningEffort,
      maxOutputTokens: CHAT_BEHAVIOR.intentRouting.maxOutputTokens,
    });

    return parseTurnRouting(text);
  }
}

export class ChatGatewayTurnRouterGateway implements TurnRouterGateway {
  constructor(private readonly chatGateway: Pick<ChatGateway, "answer">) {}

  async classify(input: TurnRouterGatewayInput): Promise<TurnRouterGatewayResult> {
    const text = await this.chatGateway.answer({
      query: input.query,
      history: input.contextMessages,
      prompt: buildTurnRouterPrompt({
        context: formatConversationContext(input.contextMessages),
        query: input.query,
      }),
      workspaceContext: input.workspaceContext,
      usageContext: input.usageContext,
    });

    return parseTurnRouting(text);
  }
}

const fallbackUsageContext = (
  input: Pick<TurnRouterInput, "workspaceContext" | "usageContext">,
): ModelCallUsageContext => ({
  workspaceId: input.usageContext?.workspaceId ?? input.workspaceContext?.workspaceId ?? "unknown",
  accountId: input.usageContext?.accountId,
  conversationId: input.usageContext?.conversationId,
  messageId: input.usageContext?.messageId,
  requestId: input.usageContext?.requestId ?? randomUUID(),
  surface: input.usageContext?.surface ?? "assistant",
  operation: "turn_router",
  attemptKey: input.usageContext?.attemptKey ?? "turn_router",
});

export class LlmTurnRouter implements TurnRouter {
  constructor(private readonly gateway: TurnRouterGateway) {}

  async classify(input: TurnRouterInput): Promise<TurnRouting> {
    try {
      return normalizeTurnRouting(await this.gateway.classify({
        query: input.query,
        contextMessages: input.history,
        workspaceContext: input.workspaceContext,
        usageContext: fallbackUsageContext(input),
      }));
    } catch {
      return {
        route: "retrieval",
        framing: {
          isIdentityQuestion: false,
        },
      };
    }
  }
}

export const normalizeTurnRouting = (result: TurnRouterGatewayResult): TurnRouting => ({
  route: result.route === "direct" ? "direct" : "retrieval",
  framing: {
    intentTopic: normalizeOptionalClassifierLabel(result.intentTopic),
    isIdentityQuestion: Boolean(result.isIdentityQuestion),
  },
});

const normalizeOptionalClassifierLabel = (value?: string | null): string | undefined =>
  typeof value === "string" ? normalizeLlmClassifierLabel(value) : undefined;
