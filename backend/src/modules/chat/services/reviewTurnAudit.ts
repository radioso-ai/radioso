import type { AuditEventInput } from "../../audit/contracts/index.js";
import type { ReviewTurnCorrelation } from "./reviewDraft.js";

/** The kind a field must have to be kept; a field of any other kind is dropped. */
type FieldKind = "string" | "number" | "boolean";
type Allowlist = Readonly<Record<string, FieldKind>>;

/**
 * The review audit's fields: identifiers, outcome codes, counts and flags. Everything else a turn's
 * audit carries (the answer and its segments, suggestions, citations, retrieval diagnostics, the
 * rewrite continuity state, activity and turn traces, an error's message) holds the customer's
 * words or the draft nobody has approved, so it is never kept (FR-045).
 */
const REVIEW_AUDIT_FIELDS: Allowlist = {
  stage: "string",
  workflow: "string",
  executionClass: "string",
  executionMode: "string",
  surface: "string",
  conversationId: "string",
  userMessageId: "string",
  stream: "boolean",
  answerOutcome: "string",
  groundingVerdict: "string",
  groundingProtocolVersion: "number",
  citationCount: "number",
};

const REVIEW_AUDIT_OBJECTS: Readonly<Record<string, Allowlist>> = {
  skillTurn: { skillName: "string", outcome: "string", status: "string" },
  route: { generator: "string", routeType: "string", routeReason: "string", retrievalInvoked: "boolean" },
  groundingDiagnostics: {
    parseStatus: "string",
    claimCount: "number",
    sourcedClaimCount: "number",
    unsourcedClaimCount: "number",
    invalidSourceCount: "number",
    assertionMismatch: "boolean",
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasKind = (value: unknown, kind: FieldKind): boolean =>
  kind === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === kind;

const pick = (source: Record<string, unknown>, fields: Allowlist): Record<string, unknown> =>
  Object.fromEntries(Object.entries(fields)
    .filter(([name, kind]) => hasKind(source[name], kind))
    .map(([name]) => [name, source[name]]));

const contentFreeMetadata = (metadata: Record<string, unknown> | undefined): Record<string, unknown> => {
  const source = metadata ?? {};
  const objects = Object.entries(REVIEW_AUDIT_OBJECTS).flatMap(([name, fields]) => {
    const value = source[name];
    const kept = isRecord(value) ? pick(value, fields) : {};
    return Object.keys(kept).length > 0 ? [[name, kept] as const] : [];
  });
  return { ...pick(source, REVIEW_AUDIT_FIELDS), ...Object.fromEntries(objects) };
};

/** An error's code, or its class name; a code that does not read as an identifier is not kept. */
const ERROR_CODE_SHAPE = /^[A-Za-z0-9_.:-]{1,64}$/;

const errorCodeOf = (error: unknown): string => {
  const code = isRecord(error) ? error.code : undefined;
  if (typeof code === "string" && ERROR_CODE_SHAPE.test(code)) {
    return code;
  }
  return error instanceof Error && ERROR_CODE_SHAPE.test(error.name) ? error.name : "unknown";
};

/**
 * A review turn's audit event: the event a turn records, kept to the review audit's fields and
 * correlated on the request it answered and the turn. It names no assistant message, because none
 * was written.
 */
export const reviewedTurnAuditEvent = (
  event: AuditEventInput,
  correlation: ReviewTurnCorrelation,
): AuditEventInput => ({
  accountId: event.accountId,
  workspaceId: event.workspaceId,
  eventType: event.eventType,
  eventStatus: event.eventStatus,
  metadata: {
    ...contentFreeMetadata(event.metadata),
    requestMessageId: correlation.requestMessageId,
    turnId: correlation.turnId,
  },
});

/** A failed review turn's audit event: the review audit's fields and the error's code, never its message. */
export const reviewTurnFailureAuditEvent = (event: AuditEventInput, error: unknown): AuditEventInput => ({
  accountId: event.accountId,
  workspaceId: event.workspaceId,
  eventType: event.eventType,
  eventStatus: event.eventStatus,
  metadata: { ...contentFreeMetadata(event.metadata), errorCode: errorCodeOf(error) },
});
