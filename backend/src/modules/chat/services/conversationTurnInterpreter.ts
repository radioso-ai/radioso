import type {
  ConversationInteractionRole,
  ConversationTurnInterpretation,
  ConversationTurnInterpreter,
} from "@radioso/conversation-contract";

import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import { CHAT_BEHAVIOR, RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type {
  ModelCallUsageAttribution,
  ModelCallUsageContext,
} from "../../../shared/domain/modelCallUsageContext.js";
import type { ModelInferencePipeline } from "../../../shared/infra/llm/modelInferencePipeline.js";
import type { ResponseIdentity } from "../../../shared/domain/responseIdentity.js";
import {
  parseStructuredRewrite,
  type RetrievalDefaultsProvider,
  type SkillSettingsResolver,
  type StructuredRewriteResult,
} from "../../retrieval/public.js";
import { renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import {
  parsePageReadDecision,
  type PageReadCapability,
  type PageReadDecision,
} from "./pageRead/pageReadDecision.js";
import { renderConversationSummarySection } from "./summary/conversationSummarySection.js";
import { normalizeTurnRouting, type TurnRouterGatewayResult, type TurnRouting } from "./turnRouter.js";
import { parseConversationInteractionRole } from "./conversationInteraction.js";

export interface ConversationTurnInterpreterInput {
  query: string;
  history: MessageRecord[];
  responseIdentity?: ResponseIdentity | null;
  customInstruction?: string;
  workspaceId: string;
  accountId?: string;
  conversationId?: string;
  messageId?: string;
  agentSkillSettings?: Record<string, unknown>;
  usageAttribution?: ModelCallUsageAttribution;
  /** Rolling conversation summary (#866) injected as background context; absent renders nothing. */
  conversationSummary?: string;
  pageReadCapability?: PageReadCapability | null;
}

export interface ConversationTurnInterpretationResult extends TurnRouting {
  /** Live fused/staged interpreters always populate this; optional keeps host adapters compatible. */
  interactionRole?: ConversationInteractionRole;
  rewriteProposal?: StructuredRewriteResult;
  pageRead?: PageReadDecision;
}

export interface ChatConversationTurnInterpreter {
  interpretChatTurn(input: ConversationTurnInterpreterInput): Promise<ConversationTurnInterpretationResult>;
}

/** Retrieval-owned dependencies used to resolve effective interpretation context. */
export interface TurnInterpretationContextSettings {
  retrievalDefaultsProvider: RetrievalDefaultsProvider;
  skillSettingsResolver?: SkillSettingsResolver;
}

export interface ResolvedTurnInterpretationContext {
  semanticRewriteInstructions?: string;
  lexicalRewriteInstructions?: string;
  conversationSummary?: string;
}

/**
 * One shared resolution seam for staged and fused interpretation: effective
 * retrieval.answer rewrite guidance and the frozen rolling summary. Answer
 * instructions intentionally stay out of pre-retrieval interpretation.
 */
export const resolveConversationTurnInterpretationContext = (
  input: Pick<
    ConversationTurnInterpreterInput,
    "workspaceId" | "agentSkillSettings" | "conversationSummary"
  >,
  settings?: TurnInterpretationContextSettings,
): ResolvedTurnInterpretationContext => {
  const defaults = settings?.retrievalDefaultsProvider.getDefaults(input.workspaceId);
  const effective = defaults && settings?.skillSettingsResolver
    ? settings.skillSettingsResolver.resolve(
        "retrieval.answer",
        defaults,
        input.agentSkillSettings?.["retrieval.answer"],
      )
    : defaults;
  return {
    ...(effective?.semanticRewriteInstructions
      ? { semanticRewriteInstructions: effective.semanticRewriteInstructions }
      : {}),
    ...(effective?.lexicalRewriteInstructions
      ? { lexicalRewriteInstructions: effective.lexicalRewriteInstructions }
      : {}),
    ...(input.conversationSummary ? { conversationSummary: input.conversationSummary } : {}),
  };
};

export interface TurnInterpretationGatewayInput {
  query: string;
  contextMessages: MessageRecord[];
  semanticRewriteInstructions?: string;
  lexicalRewriteInstructions?: string;
  conversationSummary?: string;
  pageReadCapability?: PageReadCapability | null;
  usageContext: ModelCallUsageContext;
}

export interface TurnInterpretationGatewayResult extends TurnRouterGatewayResult {
  interactionRole?: ConversationInteractionRole;
  rewrite?: StructuredRewriteResult | null;
  pageRead?: PageReadDecision;
}

export interface TurnInterpretationGateway {
  interpret(input: TurnInterpretationGatewayInput): Promise<TurnInterpretationGatewayResult>;
}

const formatConversationContext = (messages: MessageRecord[]): string =>
  messages
    .map((message) =>
      `${message.role.toUpperCase()}: ${message.content}${
        message.role === "user" ? " [authoritative for grounding]" : " [non-authoritative context]"
      }`,
    )
    .join("\n");

export const buildTurnInterpretationPrompt = (input: {
  context: string;
  semanticRewriteInstructions?: string;
  lexicalRewriteInstructions?: string;
  conversationSummary?: string;
  pageReadCapability?: PageReadCapability | null;
  query: string;
}): string => {
  const pageReadCapability = input.pageReadCapability ?? null;
  return renderPromptTemplate("chat/turn-interpretation.md", {
    context_section: input.context || "No prior context",
    conversation_summary_section: renderConversationSummarySection(input.conversationSummary),
    semantic_rewrite_instructions:
      input.semanticRewriteInstructions ?? "Use the system default semantic rewrite behavior.",
    lexical_rewrite_instructions:
      input.lexicalRewriteInstructions ?? "Use the system default lexical rewrite behavior.",
    page_read_section: pageReadCapability
      ? `\n\n${renderPromptTemplate("chat/turn-planning-page-read.md", {
          page_read_mode: pageReadCapability.mode ?? "none",
          page_read_supported_operations:
            pageReadCapability.supportedOperations.length > 0
              ? pageReadCapability.supportedOperations.join(", ")
              : "none",
        })}`
      : "",
    page_read_output_field: pageReadCapability
      ? ',"pageRead":{"required":false,"operation":"metadata|lookup|summarize|transform|null","resolvedRequest":"string|null"}'
      : "",
    query: input.query,
  });
};

export const parseTurnInterpretation = (
  raw: string,
  pageReadCapability?: PageReadCapability | null,
): TurnInterpretationGatewayResult => {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const parsed = JSON.parse(trimmed) as Record<string, unknown>;
  const expectsPageRead = pageReadCapability != null;
  const hasPageRead = Object.hasOwn(parsed, "pageRead");
  const pageRead = hasPageRead ? parsePageReadDecision(parsed.pageRead) : null;
  if ((expectsPageRead && !pageRead) || (!expectsPageRead && hasPageRead)) {
    throw new Error("invalid_page_read_decision");
  }
  const rewriteRaw = parsed.rewrite;
  return {
    route: typeof parsed.route === "string" ? parsed.route : undefined,
    interactionRole: parseConversationInteractionRole(parsed.interactionRole),
    isIdentityQuestion: typeof parsed.isIdentityQuestion === "boolean" ? parsed.isIdentityQuestion : false,
    intentTopic: typeof parsed.intentTopic === "string" ? parsed.intentTopic : null,
    inScopeRequest: typeof parsed.inScopeRequest === "string" ? parsed.inScopeRequest : null,
    outsideScopeRequest: typeof parsed.outsideScopeRequest === "string" ? parsed.outsideScopeRequest : null,
    rewrite:
      rewriteRaw && typeof rewriteRaw === "object"
        ? parseStructuredRewrite(JSON.stringify(rewriteRaw))
        : null,
    ...(pageRead ? { pageRead } : {}),
  };
};

export class ModelTurnInterpretationGateway implements TurnInterpretationGateway {
  constructor(private readonly inference: ModelInferencePipeline) {}

  async interpret(input: TurnInterpretationGatewayInput): Promise<TurnInterpretationGatewayResult> {
    const { text } = await this.inference.complete({
      operation: input.usageContext,
      prompt: buildTurnInterpretationPrompt({
        context: formatConversationContext(input.contextMessages),
        semanticRewriteInstructions: input.semanticRewriteInstructions,
        lexicalRewriteInstructions: input.lexicalRewriteInstructions,
        conversationSummary: input.conversationSummary,
        pageReadCapability: input.pageReadCapability,
        query: input.query,
      }),
      reasoningEffort: RETRIEVAL_BEHAVIOR.queryInterpretation.reasoningEffort,
      maxOutputTokens: CHAT_BEHAVIOR.intentRouting.maxOutputTokens + 768,
    });

    return parseTurnInterpretation(text, input.pageReadCapability);
  }
}

export class LlmConversationTurnInterpreter implements ChatConversationTurnInterpreter {
  constructor(
    private readonly gateway: TurnInterpretationGateway,
    private readonly retrievalDefaultsProvider?: RetrievalDefaultsProvider,
    private readonly skillSettingsResolver?: SkillSettingsResolver,
  ) {}

  async interpretChatTurn(input: ConversationTurnInterpreterInput): Promise<ConversationTurnInterpretationResult> {
    const context = resolveConversationTurnInterpretationContext(input, this.retrievalDefaultsProvider
      ? {
          retrievalDefaultsProvider: this.retrievalDefaultsProvider,
          ...(this.skillSettingsResolver ? { skillSettingsResolver: this.skillSettingsResolver } : {}),
        }
      : undefined);
    try {
      const result = await this.gateway.interpret({
        query: input.query,
        contextMessages: input.history,
        pageReadCapability: input.pageReadCapability,
        ...context,
        usageContext: {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          messageId: input.messageId,
          surface: "assistant",
          operation: "turn_interpretation",
          attemptKey: input.messageId ?? "turn_interpretation",
          ...input.usageAttribution,
        },
      });
      const routing = normalizeTurnRouting(result);
      return {
        ...routing,
        interactionRole: parseConversationInteractionRole(result.interactionRole),
        ...(routing.route === "retrieval" && result.rewrite ? { rewriteProposal: result.rewrite } : {}),
        ...(result.pageRead ? { pageRead: result.pageRead } : {}),
      };
    } catch {
      return {
        route: "retrieval",
        interactionRole: "unresolved",
        framing: { isIdentityQuestion: false },
      };
    }
  }

  forEngine(input: ConversationTurnInterpreterInput): ConversationTurnInterpreter {
    return {
      interpret: async (): Promise<ConversationTurnInterpretation> => {
        const result = await this.interpretChatTurn(input);
        return {
          route: result.route,
          interactionRole: result.interactionRole,
          framing: result.framing,
          metadata: result.rewriteProposal ? { rewriteProposal: result.rewriteProposal } : undefined,
        };
      },
    };
  }

}
