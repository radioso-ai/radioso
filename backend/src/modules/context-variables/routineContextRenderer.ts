/**
 * How a `{{context.<name>}}` reference in a routine step instruction reads at runtime.
 *
 * The engine substitutes the token with whatever this renderer returns, so this is the one
 * place that decides what a step may see of a context variable. Every value is framed as
 * data (`<page_context>…</page_context>`, `<context_variable name="…">…</context_variable>`)
 * so the step-reply prompt can tell the model it is visitor situation, never instruction.
 *
 * Staged context carries raw values (the redacted projection is the snapshot, not the staged
 * entry), so the sensitivity and surfacing rules are applied here from the staged metadata:
 * a sensitive value renders as the redaction marker, an `operator_only` value renders nothing.
 */

import type { RoutineContextRenderer, StagedContext } from "@radioso/conversation-contract";

import { CONTEXT_VARIABLES_BEHAVIOR } from "../../shared/domain/behaviorConfig.js";
import { boundContextVariableFragments } from "./contextVariablesBound.js";
import { REDACTED_VALUE } from "./redaction.js";
import { PAGE_CONTEXT_VARIABLE_NAME } from "./contextResolutionService.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const usableString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const stagedVariableName = (staged: StagedContext): string | null =>
  (isRecord(staged.metadata) ? usableString(staged.metadata.variableName) : null) ?? usableString(staged.id);

const findStagedVariable = (name: string, stagedContext: readonly StagedContext[]): StagedContext | null =>
  stagedContext.find((staged) => staged.kind === "context_variable" && stagedVariableName(staged) === name) ?? null;

// Only the page's identity reaches a step instruction: URL, title, and language. The visible
// page excerpt stays out — it is the injection surface, and the page-read pipeline already
// hands the model the excerpt as evidence where a turn needs it.
const renderPageContext = (data: unknown): string | null => {
  if (!isRecord(data)) {
    return null;
  }
  const pageUrl = usableString(data.pageUrl);
  const pageTitle = usableString(data.pageTitle);
  const pageLocale = usableString(data.pageLocale);
  if (!pageUrl && !pageTitle && !pageLocale) {
    return null;
  }
  const identity = [pageTitle ? `"${pageTitle}"` : null, pageUrl ? (pageTitle ? `(${pageUrl})` : pageUrl) : null]
    .filter((part): part is string => part !== null)
    .join(" ");
  const language = pageLocale ? `language ${pageLocale}` : null;
  const line = [identity || null, language].filter((part): part is string => part !== null).join(", ");
  return `<page_context>Current page: ${line}</page_context>`;
};

const stagedValue = (data: unknown): unknown =>
  isRecord(data) && data.kind === "variable" && "value" in data ? data.value : data;

const renderVariable = (name: string, staged: StagedContext): string | null => {
  const metadata = isRecord(staged.metadata) ? staged.metadata : {};
  if (metadata.surfacing === "operator_only") {
    return null;
  }
  const text = metadata.sensitive === true
    ? REDACTED_VALUE
    : boundedValueText(name, stagedValue(staged.data));
  return text === null ? null : `<context_variable name="${name}">${text}</context_variable>`;
};

// Strings read as-is; anything structured reads as JSON, clamped by the same per-value bound
// the answer prompt applies to always-surfaced variables.
const boundedValueText = (name: string, value: unknown): string | null => {
  if (value === undefined || value === null) {
    return null;
  }
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof raw !== "string") {
    return null;
  }
  const bound = boundContextVariableFragments([{ name, prefix: "", value: raw }], {
    ...CONTEXT_VARIABLES_BEHAVIOR.renderBound,
    // One value at a time: the count and section caps are for the prompt block, not a single reference.
    maxRenderedVariables: 1,
    sectionTokenBudget: Number.POSITIVE_INFINITY,
  });
  return bound.kept[0]?.value ?? null;
};

export const routineContextRenderer: RoutineContextRenderer = {
  render({ name, stagedContext }) {
    const staged = findStagedVariable(name, stagedContext);
    if (!staged) {
      return null;
    }
    return name === PAGE_CONTEXT_VARIABLE_NAME
      ? renderPageContext(staged.data)
      : renderVariable(name, staged);
  },
};
