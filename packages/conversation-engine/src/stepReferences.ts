import type {
  RoutineContextRenderer,
  RoutineStep,
  RoutineStepReplyInput,
  TurnContext,
} from "@radioso/conversation-contract";

// A step instruction embeds two kinds of reference: `{{slot.<key>}}` reads a captured
// variable, `{{context.<name>}}` reads a staged context variable (the visitor's current
// page, a host-pushed value). Both resolve in ONE pass over the authored text, so a value
// substituted for one reference is never re-scanned for the other — a visitor-typed slot
// value or a page title cannot smuggle a second reference in.
export const STEP_REFERENCE = /\{\{\s*(slot|context)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu;

const stringifySlotValue = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return value.toString();
  }
  if (value === null || value === undefined) {
    return "";
  }
  return Array.isArray(value) ? value.toString() : Object.prototype.toString.call(value);
};

/**
 * Fills captured slots and referenced context into a step's authored instruction before it
 * is rendered. The host's renderer decides what any context variable looks like; the engine
 * only substitutes. An uncaptured slot, an absent or withheld context variable, or no
 * context renderer at all leaves an empty string, never the raw token.
 */
const resolveStepAction = (
  action: string,
  variables: Record<string, unknown>,
  stagedContext: TurnContext["stagedContext"],
  contextRenderer: RoutineContextRenderer | undefined,
): string =>
  action.replace(STEP_REFERENCE, (_match, kind: string, name: string) => {
    if (kind === "context") {
      return contextRenderer?.render({ name, stagedContext }) ?? "";
    }
    return Object.prototype.hasOwnProperty.call(variables, name) ? stringifySlotValue(variables[name]) : "";
  });

/** The evidence of each context variable the instruction references, once per variable. */
const contextEvidenceFor = (
  action: string,
  stagedContext: TurnContext["stagedContext"],
  contextRenderer: RoutineContextRenderer | undefined,
): string[] => {
  const names = new Set(
    [...action.matchAll(STEP_REFERENCE)].flatMap(([, kind, name]) => kind === "context" && name ? [name] : []),
  );
  return [...names].flatMap((name) => contextRenderer?.evidence?.({ name, stagedContext }) ?? []);
};

/**
 * The step a reply is written from: its instruction with references filled in, and beside it
 * the untrusted evidence the referenced context variables carry, which never enters the
 * instruction.
 */
export const stepForReply = (
  step: RoutineStep,
  variables: Record<string, unknown>,
  stagedContext: TurnContext["stagedContext"],
  contextRenderer: RoutineContextRenderer | undefined,
): Pick<RoutineStepReplyInput, "step" | "contextEvidence"> => {
  if (!step.action) {
    return { step };
  }
  const contextEvidence = contextEvidenceFor(step.action, stagedContext, contextRenderer);
  return {
    step: { ...step, action: resolveStepAction(step.action, variables, stagedContext, contextRenderer) },
    ...(contextEvidence.length > 0 ? { contextEvidence } : {}),
  };
};
