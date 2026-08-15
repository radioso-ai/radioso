import type {
  DirectiveCoherenceConflict,
  DirectiveCoherenceError,
  DirectiveCoherenceVerdict,
} from "@radioso/conversation-contract";

const DIRECTIVE_COHERENCE_ERROR_CODE = "conversation_kit_directive_coherence_conflict";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isConflict = (value: unknown): value is DirectiveCoherenceConflict =>
  isRecord(value) &&
  (value.directiveId === undefined || typeof value.directiveId === "string") &&
  typeof value.directiveName === "string" &&
  typeof value.reason === "string";

const isVerdict = (value: unknown): value is DirectiveCoherenceVerdict =>
  isRecord(value) &&
  typeof value.coherent === "boolean" &&
  Array.isArray(value.conflicts) &&
  value.conflicts.every(isConflict) &&
  typeof value.rationale === "string";

/**
 * Narrows an unknown thrown value to the public directive-coherence rejection
 * shape without relying on the defaults package's concrete error instance.
 */
export const isDirectiveCoherenceError = (value: unknown): value is DirectiveCoherenceError =>
  isRecord(value) &&
  value.code === DIRECTIVE_COHERENCE_ERROR_CODE &&
  isVerdict(value.verdict);
