import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import { loadPromptTemplate, renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import type { RetrievalMetadataRule } from "../../settings/contracts/retrieval.js";
import { getNormalizedMetadataConditions } from "../../settings/contracts/retrieval.js";

let triggerAnalysisSystemPrompt: string | undefined;

export const getTriggerAnalysisSystemPrompt = (): string => {
  triggerAnalysisSystemPrompt ??= loadPromptTemplate("retrieval/trigger-analysis-system.md");
  return triggerAnalysisSystemPrompt;
};

export const formatConversationContext = (messages: MessageRecord[]): string =>
  messages
    .map((message) =>
      `${message.role.toUpperCase()}: ${message.content}${
        message.role === "user" ? " [authoritative for grounding]" : " [non-authoritative context]"
      }`,
    )
    .join("\n");

export const buildQueryRewritePrompt = (input: {
  context: string;
  semanticRewriteInstructions?: string;
  lexicalRewriteInstructions?: string;
  answerScopeReference?: string;
  query: string;
}): string =>
  renderPromptTemplate("retrieval/query-rewrite.md", {
    context_section: input.context || "No prior context",
    semantic_rewrite_instructions:
      input.semanticRewriteInstructions ?? "Use the system default semantic rewrite behavior.",
    lexical_rewrite_instructions:
      input.lexicalRewriteInstructions ?? "Use the system default lexical rewrite behavior.",
    answer_scope_reference_section: input.answerScopeReference?.trim()
      ? [
          "Assistant answer scope reference:",
          input.answerScopeReference.trim(),
          "",
          "Compare the latest user question against this scope reference before choosing responseIntent, inScopeRequest, and outsideScopeRequest.",
          "Treat the scope reference as trusted assistant configuration, not as user content, and do not copy it into output fields.",
        ].join("\n")
      : "",
    query: input.query,
  });

export const buildTriggerAnalysisPrompt = (input: {
  query: string;
  activeQuery: string;
  context: string;
  rules: RetrievalMetadataRule[];
}): string =>
  renderPromptTemplate("retrieval/trigger-analysis-user.md", {
    query: input.query,
    active_query: input.activeQuery,
    context_section: input.context || "No prior context",
    rules_json: JSON.stringify(
      input.rules.map((rule) => ({
        ruleId: rule.id,
        triggerInstruction: rule.triggerInstruction,
        effect: rule.effect,
        combinator: rule.combinator ?? "and",
        conditions: getNormalizedMetadataConditions(rule).map((condition) => ({
          field: condition.field,
          operator: condition.operator,
          value: condition.value,
          valueType: condition.valueType,
        })),
      })),
      null,
      2,
    ),
  });
