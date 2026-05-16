import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { TextGenerationClient } from "../../../shared/infra/llm/providerTypes.js";
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
}

export interface QueryRewriteGateway {
  rewrite(input: {
    query: string;
    contextMessages: MessageRecord[];
    semanticRewriteInstructions?: string;
    lexicalRewriteInstructions?: string;
    answerScopeReference?: string;
  }): Promise<QueryRewriteGatewayResult>;
}

export interface TriggerAnalysisGateway {
  analyze(input: TriggerAnalysisGatewayInput): Promise<TriggerAnalysisResult>;
}

export class ModelTriggerAnalysisGateway implements TriggerAnalysisGateway {
  constructor(private readonly client: TextGenerationClient) {}

  async analyze(input: TriggerAnalysisGatewayInput): Promise<TriggerAnalysisResult> {
    const raw = await this.client.complete({
      systemPrompt: getTriggerAnalysisSystemPrompt(),
      prompt: buildTriggerAnalysisPrompt({
        query: input.query,
        activeQuery: input.activeQuery,
        context: formatConversationContext(input.contextMessages),
        rules: input.rules,
      }),
    });

    return parseStructuredTriggerAnalysis(raw, input.rules);
  }
}

export class ModelQueryRewriteGateway implements QueryRewriteGateway {
  constructor(private readonly client: TextGenerationClient) {}

  async rewrite(input: {
    query: string;
    contextMessages: MessageRecord[];
    semanticRewriteInstructions?: string;
    lexicalRewriteInstructions?: string;
    answerScopeReference?: string;
  }): Promise<StructuredRewriteResult> {
    const raw = await this.client.complete({
      prompt: buildQueryRewritePrompt({
        context: formatConversationContext(input.contextMessages),
        semanticRewriteInstructions: input.semanticRewriteInstructions,
        lexicalRewriteInstructions: input.lexicalRewriteInstructions,
        answerScopeReference: input.answerScopeReference,
        query: input.query,
      }),
    });

    return parseStructuredRewrite(raw);
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
