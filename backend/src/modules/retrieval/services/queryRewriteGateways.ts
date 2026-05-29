import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { ModelCallUsageContext } from "../../../shared/domain/modelCallUsageContext.js";
import type { LlmCapabilityResolveInput } from "../../../shared/infra/llm/workspaceContext.js";
import type { ModelInferencePipeline } from "../../../shared/infra/llm/modelInferencePipeline.js";
import type { RetrievalMetadataRule } from "../../settings/contracts/retrieval.js";
import type {
  StructuredRewriteResult,
  TriggerAnalysisResult,
} from "../domain/retrievalPipelineTypes.js";
import {
  buildQueryRewritePrompt,
  buildTriggerAnalysisPrompt,
  formatConversationContext,
  getTriggerAnalysisSystemPrompt,
} from "./queryRewritePromptBuilder.js";
import { parseStructuredRewrite, parseStructuredTriggerAnalysis } from "./queryRewriteParser.js";

export interface QueryRewriteGatewayFallbackResult {
  rewrittenQuery: string;
  semanticQuery?: string;
  lexicalQuery?: string;
  confidence: number;
}

export type QueryRewriteGatewayResult = QueryRewriteGatewayFallbackResult | StructuredRewriteResult;

export interface TriggerAnalysisGatewayInput {
  query: string;
  activeQuery: string;
  contextMessages: MessageRecord[];
  rules: RetrievalMetadataRule[];
  workspaceContext?: LlmCapabilityResolveInput;
  usageContext: ModelCallUsageContext;
}

export interface QueryRewriteGatewayInput {
  query: string;
  contextMessages: MessageRecord[];
  semanticRewriteInstructions?: string;
  lexicalRewriteInstructions?: string;
  answerScopeReference?: string;
  workspaceContext?: LlmCapabilityResolveInput;
  usageContext: ModelCallUsageContext;
}

export interface QueryRewriteGateway {
  rewrite(input: QueryRewriteGatewayInput): Promise<QueryRewriteGatewayResult>;
}

export interface TriggerAnalysisGateway {
  analyze(input: TriggerAnalysisGatewayInput): Promise<TriggerAnalysisResult>;
}

export class ModelTriggerAnalysisGateway implements TriggerAnalysisGateway {
  constructor(private readonly inference: ModelInferencePipeline) {}

  async analyze(input: TriggerAnalysisGatewayInput): Promise<TriggerAnalysisResult> {
    const { text } = await this.inference.complete({
      operation: input.usageContext,
      systemPrompt: getTriggerAnalysisSystemPrompt(),
      prompt: buildTriggerAnalysisPrompt({
        query: input.query,
        activeQuery: input.activeQuery,
        context: formatConversationContext(input.contextMessages),
        rules: input.rules,
      }),
    });

    return parseStructuredTriggerAnalysis(text, input.rules);
  }
}

export class ModelQueryRewriteGateway implements QueryRewriteGateway {
  constructor(private readonly inference: ModelInferencePipeline) {}

  async rewrite(input: QueryRewriteGatewayInput): Promise<StructuredRewriteResult> {
    const { text } = await this.inference.complete({
      operation: input.usageContext,
      prompt: buildQueryRewritePrompt({
        context: formatConversationContext(input.contextMessages),
        semanticRewriteInstructions: input.semanticRewriteInstructions,
        lexicalRewriteInstructions: input.lexicalRewriteInstructions,
        answerScopeReference: input.answerScopeReference,
        query: input.query,
      }),
    });

    return parseStructuredRewrite(text);
  }
}

export class OpenAIQueryRewriteGateway implements QueryRewriteGateway {
  constructor(
    private readonly client: {
      chat: {
        completions: {
          create(input: {
            model: string;
            messages: Array<{ role: "system" | "user"; content: string }>;
          }): Promise<{ choices?: Array<{ message?: { content?: string | null } }> }>;
        };
      };
    },
    private readonly model: string,
  ) {}

  async rewrite(input: {
    query: string;
    contextMessages: MessageRecord[];
    semanticRewriteInstructions?: string;
    lexicalRewriteInstructions?: string;
    answerScopeReference?: string;
  }): Promise<StructuredRewriteResult> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: "user",
          content: buildQueryRewritePrompt({
            context: formatConversationContext(input.contextMessages),
            semanticRewriteInstructions: input.semanticRewriteInstructions,
            lexicalRewriteInstructions: input.lexicalRewriteInstructions,
            answerScopeReference: input.answerScopeReference,
            query: input.query,
          }),
        },
      ],
    });

    const raw = response.choices?.[0]?.message?.content?.trim() ?? "";
    return parseStructuredRewrite(raw);
  }
}
