import type {
  ConversationTurnInterpretation,
  ConversationTurnInterpreter,
} from "@radioso/conversation-contract";

import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import { CHAT_BEHAVIOR, RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { ModelCallUsageContext } from "../../../shared/domain/modelCallUsageContext.js";
import type { ModelInferencePipeline } from "../../../shared/infra/llm/modelInferencePipeline.js";
import type { ResponseIdentity } from "../../../shared/domain/responseIdentity.js";
import {
  parseStructuredRewrite,
  SharedAnswerInstructionBuilder,
  type RetrievalDefaultsProvider,
  type SkillSettingsResolver,
  type StructuredRewriteResult,
} from "../../retrieval/public.js";
import { renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import { renderConversationSummarySection } from "./summary/conversationSummarySection.js";
import { normalizeTurnRouting, type TurnRouterGatewayResult, type TurnRouting } from "./turnRouter.js";

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
  /** Rolling conversation summary (#866) injected as background context; absent renders nothing. */
  conversationSummary?: string;
}

export interface ConversationTurnInterpretationResult extends TurnRouting {
  rewriteProposal?: StructuredRewriteResult;
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
  answerScopeReference: string;
  semanticRewriteInstructions?: string;
  lexicalRewriteInstructions?: string;
  conversationSummary?: string;
}

const answerInstructionBuilder = new SharedAnswerInstructionBuilder();

/**
 * One shared resolution seam for staged and fused interpretation: configured
 * answer scope, effective retrieval.answer rewrite guidance, and the frozen
 * rolling summary. Keeping this here prevents the two prompt paths from drifting.
 */
export const resolveConversationTurnInterpretationContext = (
  input: Pick<
    ConversationTurnInterpreterInput,
    "workspaceId" | "responseIdentity" | "customInstruction" | "agentSkillSettings" | "conversationSummary"
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
    answerScopeReference: answerInstructionBuilder.buildScopeReferenceBlock({
      responseIdentity: input.responseIdentity,
      customInstruction: input.customInstruction,
    }),
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
  answerScopeReference: string;
  semanticRewriteInstructions?: string;
  lexicalRewriteInstructions?: string;
  conversationSummary?: string;
  usageContext: ModelCallUsageContext;
}

export interface TurnInterpretationGatewayResult extends TurnRouterGatewayResult {
  rewrite?: StructuredRewriteResult | null;
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
  answerScopeReference: string;
  semanticRewriteInstructions?: string;
  lexicalRewriteInstructions?: string;
  conversationSummary?: string;
  query: string;
}): string =>
  renderPromptTemplate("chat/turn-interpretation.md", {
    context_section: input.context || "No prior context",
    conversation_summary_section: renderConversationSummarySection(input.conversationSummary),
    answer_scope_reference_section: input.answerScopeReference || "No configured answer scope.",
    semantic_rewrite_instructions:
      input.semanticRewriteInstructions ?? "Use the system default semantic rewrite behavior.",
    lexical_rewrite_instructions:
      input.lexicalRewriteInstructions ?? "Use the system default lexical rewrite behavior.",
    query: input.query,
  });

export const parseTurnInterpretation = (raw: string): TurnInterpretationGatewayResult => {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const parsed = JSON.parse(trimmed) as Record<string, unknown>;
  const rewriteRaw = parsed.rewrite;
  return {
    route: typeof parsed.route === "string" ? parsed.route : undefined,
    isIdentityQuestion: typeof parsed.isIdentityQuestion === "boolean" ? parsed.isIdentityQuestion : false,
    intentTopic: typeof parsed.intentTopic === "string" ? parsed.intentTopic : null,
    inScopeRequest: typeof parsed.inScopeRequest === "string" ? parsed.inScopeRequest : null,
    outsideScopeRequest: typeof parsed.outsideScopeRequest === "string" ? parsed.outsideScopeRequest : null,
    rewrite:
      rewriteRaw && typeof rewriteRaw === "object"
        ? parseStructuredRewrite(JSON.stringify(rewriteRaw))
        : null,
  };
};

export class ModelTurnInterpretationGateway implements TurnInterpretationGateway {
  constructor(private readonly inference: ModelInferencePipeline) {}

  async interpret(input: TurnInterpretationGatewayInput): Promise<TurnInterpretationGatewayResult> {
    const { text } = await this.inference.complete({
      operation: input.usageContext,
      prompt: buildTurnInterpretationPrompt({
        context: formatConversationContext(input.contextMessages),
        answerScopeReference: input.answerScopeReference,
        semanticRewriteInstructions: input.semanticRewriteInstructions,
        lexicalRewriteInstructions: input.lexicalRewriteInstructions,
        conversationSummary: input.conversationSummary,
        query: input.query,
      }),
      reasoningEffort: RETRIEVAL_BEHAVIOR.queryInterpretation.reasoningEffort,
      maxOutputTokens: CHAT_BEHAVIOR.intentRouting.maxOutputTokens + 768,
    });

    return parseTurnInterpretation(text);
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
        ...context,
        usageContext: {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          messageId: input.messageId,
          surface: "assistant",
          operation: "turn_interpretation",
          attemptKey: input.messageId ?? "turn_interpretation",
        },
      });
      const routing = normalizeTurnRouting(result);
      return {
        ...routing,
        ...(routing.route === "retrieval" && result.rewrite ? { rewriteProposal: result.rewrite } : {}),
      };
    } catch {
      return {
        route: "retrieval",
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
          framing: result.framing,
          metadata: result.rewriteProposal ? { rewriteProposal: result.rewriteProposal } : undefined,
        };
      },
    };
  }

}
