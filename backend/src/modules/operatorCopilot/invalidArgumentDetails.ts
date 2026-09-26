const MAX_REJECTION_LENGTH = 300;
const MAX_DIAGNOSTICS = 40;
const MAX_DIAGNOSTIC_LOCATION_LENGTH = 240;

export interface OperatorMcpRoutineDiagnostic {
  readonly routineId: string | null;
  readonly routineName?: string;
  readonly code: string;
  readonly location: string;
  readonly message: string;
}

export type OperatorMcpRejectionDetail = string | OperatorMcpRoutineDiagnostic;

/**
 * A tool's own account of why it refused the call. Unlike a schema rejection this is a sentence,
 * and some of them name a workspace object the credential already reads through other tools — it
 * stays inside the caller's own authority, not below it. Bounded here rather than only at the
 * transport, so the size of what leaves is decided where it is written.
 */
export const toolRejectionDetail = (
  message: string,
  rawDiagnostics?: unknown,
): readonly OperatorMcpRejectionDetail[] => {
  const diagnostics = Array.isArray(rawDiagnostics)
    ? rawDiagnostics.flatMap((raw): OperatorMcpRoutineDiagnostic[] => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const diagnostic = raw as Record<string, unknown>;
      if (diagnostic.safeDiagnostic !== true || typeof diagnostic.code !== "string" || typeof diagnostic.location !== "string" || typeof diagnostic.message !== "string") return [];
      return [{
        routineId: typeof diagnostic.routineId === "string" ? diagnostic.routineId.slice(0, MAX_REJECTION_LENGTH) : null,
        code: diagnostic.code.slice(0, MAX_REJECTION_LENGTH),
        location: diagnostic.location.slice(0, MAX_DIAGNOSTIC_LOCATION_LENGTH),
        message: diagnostic.message.slice(0, MAX_REJECTION_LENGTH),
      }];
    }).slice(0, MAX_DIAGNOSTICS)
    : [];
  return diagnostics.length > 0 ? [...diagnostics, message.slice(0, MAX_REJECTION_LENGTH)] : [message.slice(0, MAX_REJECTION_LENGTH)];
};

/** Re-validates a receipt snapshot before it is persisted or replayed across process versions. */
export const boundRejectionDetails = (details: unknown): readonly OperatorMcpRejectionDetail[] => {
  if (!Array.isArray(details)) return [];
  const diagnostics = details.flatMap((detail): OperatorMcpRoutineDiagnostic[] => {
    if (!detail || typeof detail !== "object" || Array.isArray(detail)) return [];
    const diagnostic = detail as Record<string, unknown>;
    if (typeof diagnostic.code !== "string" || typeof diagnostic.location !== "string" || typeof diagnostic.message !== "string") return [];
    return [{ routineId: typeof diagnostic.routineId === "string" ? diagnostic.routineId.slice(0, MAX_REJECTION_LENGTH) : null, code: diagnostic.code.slice(0, MAX_REJECTION_LENGTH), location: diagnostic.location.slice(0, MAX_DIAGNOSTIC_LOCATION_LENGTH), message: diagnostic.message.slice(0, MAX_REJECTION_LENGTH) }];
  }).slice(0, MAX_DIAGNOSTICS);
  const messages = details.filter((detail): detail is string => typeof detail === "string")
    .slice(0, MAX_DIAGNOSTICS)
    .map((detail) => detail.slice(0, MAX_REJECTION_LENGTH));
  return [...diagnostics, ...messages].slice(0, MAX_DIAGNOSTICS);
};
