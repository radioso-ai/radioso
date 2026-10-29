import { renderPromptTemplate } from "../../../../shared/infra/prompts/promptLoader.js";
import type { PageReadIntent, PageReadRequest } from "./pageReadDecision.js";
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

const isNamedIntent = (operation: PageReadRequest): operation is PageReadIntent => operation !== "context";

/**
 * The condition an answer explains about the page: for the strongest contributor that named
 * an operation, whether the page could serve it. A request for the page as context (a routine
 * step that reads it) asks nothing the reply must answer, so it never brings a condition of its
 * own, yet it never hides one a named request brings in the same turn. Its read is served at
 * the richest operation the channel offers, so a `metadata` serve means no content was there.
 */
export const pageContextConditionFor = (
  outcome: PageReadOutcome | undefined,
): PageContextCondition | null => {
  if (!outcome || !outcome.merged.decision.required) {
    return null;
  }
  const named = outcome.merged.contributors.find((contributor) => isNamedIntent(contributor.operation));
  if (!named || !isNamedIntent(named.operation)) {
    return null;
  }
  if (named.operation === "transform") {
    return { kind: "page_operation_unsupported", operation: "transform", resolvedRequest: named.resolvedRequest };
  }
  const served = outcome.gate.kind === "capture" ? outcome.gate.operation : null;
  if (served === null || (served === "metadata" && named.operation !== "metadata")) {
    return { kind: "page_context_unavailable", operation: named.operation, resolvedRequest: named.resolvedRequest };
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
