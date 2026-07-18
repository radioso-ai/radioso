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
}

export interface ConversationTurnInterpretationResult extends TurnRouting {
  rewriteProposal?: StructuredRewriteResult;
}

export interface ChatConversationTurnInterpreter {
  interpretChatTurn(input: ConversationTurnInterpreterInput): Promise<ConversationTurnInterpretationResult>;
}

export interface TurnInterpretationGatewayInput {
  query: string;
  contextMessages: MessageRecord[];
  answerScopeReference: string;
  semanticRewriteInstructions?: string;
  lexicalRewriteInstructions?: string;
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
  query: string;
}): string =>
  renderPromptTemplate("chat/turn-interpretation.md", {
    context_section: input.context || "No prior context",
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
        query: input.query,
      }),
      reasoningEffort: RETRIEVAL_BEHAVIOR.queryInterpretation.reasoningEffort,
      maxOutputTokens: CHAT_BEHAVIOR.intentRouting.maxOutputTokens + 768,
    });

    return parseTurnInterpretation(text);
  }
}

export class LlmConversationTurnInterpreter implements ChatConversationTurnInterpreter {
  private readonly answerInstructionBuilder = new SharedAnswerInstructionBuilder();

  constructor(
    private readonly gateway: TurnInterpretationGateway,
    private readonly retrievalDefaultsProvider?: RetrievalDefaultsProvider,
    private readonly skillSettingsResolver?: SkillSettingsResolver,
  ) {}

  async interpretChatTurn(input: ConversationTurnInterpreterInput): Promise<ConversationTurnInterpretationResult> {
    const answerScopeReference = this.answerInstructionBuilder.buildScopeReferenceBlock({
      responseIdentity: input.responseIdentity,
      customInstruction: input.customInstruction,
    });
    const settings = this.retrievalDefaultsProvider
      ? this.skillSettingsResolver
        ? this.skillSettingsResolver.resolve(
            "retrieval.answer",
            this.retrievalDefaultsProvider.getDefaults(input.workspaceId),
            input.agentSkillSettings?.["retrieval.answer"],
          )
        : this.retrievalDefaultsProvider.getDefaults(input.workspaceId)
      : undefined;
    try {
      const result = await this.gateway.interpret({
        query: input.query,
        contextMessages: input.history,
        answerScopeReference,
        semanticRewriteInstructions: settings?.semanticRewriteInstructions,
        lexicalRewriteInstructions: settings?.lexicalRewriteInstructions,
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
