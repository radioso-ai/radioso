/**
 * Public entry point for the context-classification module: the AI fills an agent's classified
 * Choice attributes from the conversation. Chat and composition import from here only.
 */
export {
  CONTEXT_CLASSIFICATION_PROMPT_VERSION,
  ClassificationOutputError,
  buildClassificationPrompt,
  classificationResponseFormat,
  parseClassificationOutput,
} from "./classificationPrompt.js";
export {
  CONTEXT_CLASSIFICATION_RUNS_TOTAL,
  ConversationClassificationService,
} from "./conversationClassifier.js";
export type { ClassificationRunOutcome } from "./conversationClassifier.js";
export {
  contextClassificationHandler,
  contextClassificationRequest,
} from "./classificationJob.js";
export type {
  ClassificationInferenceFactory,
  ConversationExcerpt,
  ConversationExcerptReader,
} from "./contracts.js";
