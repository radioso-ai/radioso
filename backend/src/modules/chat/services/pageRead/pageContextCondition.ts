import { renderPromptTemplate } from "../../../../shared/infra/prompts/promptLoader.js";
import type { PageReadIntent } from "./pageReadDecision.js";
import type { PageReadOutcome } from "./pageReadSessionOutcome.js";

export type PageContextCondition =
  | {
      kind: "page_context_unavailable";
      operation: PageReadIntent;
      resolvedRequest: string;
    }
  | {
      kind: "page_operation_unsupported";
      operation: "transform";
      resolvedRequest: string;
    };

export const pageContextConditionFor = (
  outcome: PageReadOutcome | undefined,
): PageContextCondition | null => {
  if (!outcome || !outcome.merged.decision.required) {
    return null;
  }
  if (outcome.gate.kind === "unavailable") {
    return {
      kind: "page_context_unavailable",
      operation: outcome.merged.decision.operation,
      resolvedRequest: outcome.merged.decision.resolvedRequest,
    };
  }
  if (
    outcome.gate.kind === "unsupported_operation" &&
    outcome.merged.decision.operation === "transform"
  ) {
    return {
      kind: "page_operation_unsupported",
      operation: "transform",
      resolvedRequest: outcome.merged.decision.resolvedRequest,
    };
  }
  return null;
};

export const renderPageContextCondition = (
  condition: PageContextCondition | null | undefined,
): string =>
  condition
    ? renderPromptTemplate("chat/page-context-condition.md", {
        condition_kind: condition.kind,
        operation: condition.operation,
        resolved_request: condition.resolvedRequest,
      })
    : "";
