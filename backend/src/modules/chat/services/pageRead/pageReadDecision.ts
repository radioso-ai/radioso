export const PAGE_READ_OPERATIONS = ["metadata", "lookup", "summarize"] as const;
export const PAGE_READ_INTENTS = [...PAGE_READ_OPERATIONS, "transform"] as const;

export type PageReadOperation = (typeof PAGE_READ_OPERATIONS)[number];
export type PageReadIntent = PageReadOperation | "transform";
/**
 * What a contributor asks of the page: one intent, or `context` — the page as context for the
 * turn, which the gate serves at the richest operation the channel supports.
 */
export type PageReadRequest = PageReadIntent | "context";

export interface PageReadCapability {
  available: boolean;
  mode: "metadata" | "content" | null;
  supportedOperations: PageReadOperation[];
}

/** The planner decides for one intent; the merged decision may carry a `context` request. */
export type PageReadDecision<Request extends PageReadRequest = PageReadIntent> =
  | { required: false; operation: null; resolvedRequest: null }
  | { required: true; operation: Request; resolvedRequest: string };

export type PageReadCandidateSource =
  | { kind: "routine"; routineId: string }
  | { kind: "directive"; directiveId: string }
  | { kind: "planner" };

export interface PageReadCandidate {
  source: PageReadCandidateSource;
  /** Omitted when the contributor asks for the page as context rather than for one operation. */
  operation?: PageReadIntent;
  resolvedRequest?: string;
}

export interface MergedPageReadDecision {
  decision: PageReadDecision<PageReadRequest>;
  /** Every contributing candidate after defaulting; first entry is the winner. */
  contributors: Array<{
    source: PageReadCandidateSource;
    operation: PageReadRequest;
    resolvedRequest: string;
  }>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};

const isPageReadIntent = (value: unknown): value is PageReadIntent =>
  typeof value === "string" && PAGE_READ_INTENTS.some((intent) => intent === value);

export const parsePageReadDecision = (value: unknown): PageReadDecision | null => {
  if (!isRecord(value) || !hasExactKeys(value, ["required", "operation", "resolvedRequest"])) {
    return null;
  }
  if (value.required === false) {
    return value.operation === null && value.resolvedRequest === null
      ? { required: false, operation: null, resolvedRequest: null }
      : null;
  }
  if (
    value.required === true &&
    isPageReadIntent(value.operation) &&
    typeof value.resolvedRequest === "string" &&
    value.resolvedRequest.trim().length > 0
  ) {
    return {
      required: true,
      operation: value.operation,
      resolvedRequest: value.resolvedRequest,
    };
  }
  return null;
};

const SOURCE_AUTHORITY: Record<PageReadCandidateSource["kind"], number> = {
  routine: 0,
  directive: 1,
  planner: 2,
};

// A `context` request names no need of its own, so within one authority any contributor that
// names an operation wins over it.
const OPERATION_BREADTH: Record<PageReadRequest, number> = {
  transform: 0,
  summarize: 1,
  lookup: 2,
  metadata: 3,
  context: 4,
};

const sourceKey = (source: PageReadCandidateSource): string => {
  if (source.kind === "routine") {
    return source.routineId;
  }
  if (source.kind === "directive") {
    return source.directiveId;
  }
  return "";
};

const compareSourceKeys = (
  left: PageReadCandidateSource,
  right: PageReadCandidateSource,
): number => {
  const leftKey = sourceKey(left);
  const rightKey = sourceKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
};

export const mergePageReadDecision = (input: {
  planner: PageReadDecision | null;
  routineCandidates: readonly PageReadCandidate[];
  directiveCandidates: readonly PageReadCandidate[];
  fallbackRequest: string;
}): MergedPageReadDecision => {
  const candidates: PageReadCandidate[] = [
    ...input.routineCandidates,
    ...input.directiveCandidates,
    ...(input.planner?.required
      ? [{
          source: { kind: "planner" } as const,
          operation: input.planner.operation,
          resolvedRequest: input.planner.resolvedRequest,
        }]
      : []),
  ];
  const contributors = candidates
    .map((candidate): MergedPageReadDecision["contributors"][number] => ({
      source: candidate.source,
      operation: candidate.operation ?? "context",
      resolvedRequest: candidate.resolvedRequest ?? input.fallbackRequest,
    }))
    .sort((left, right) =>
      SOURCE_AUTHORITY[left.source.kind] - SOURCE_AUTHORITY[right.source.kind] ||
      OPERATION_BREADTH[left.operation] - OPERATION_BREADTH[right.operation] ||
      compareSourceKeys(left.source, right.source),
    );
  const winner = contributors[0];
  if (!winner) {
    return {
      decision: { required: false, operation: null, resolvedRequest: null },
      contributors,
    };
  }
  return {
    decision: {
      required: true,
      operation: winner.operation,
      resolvedRequest: winner.resolvedRequest,
    },
    contributors,
  };
};

export type PageReadGateOutcome =
  | { kind: "not_required" }
  | { kind: "capture"; operation: PageReadOperation; resolvedRequest: string }
  | { kind: "unavailable" }
  | { kind: "unsupported_operation" };

// The operations a `context` request accepts, in the order the gate tries them: the page's
// content where the channel sends it (a lookup first, since a reference reads facts from the
// page), then the page's identity alone.
const CONTEXT_OPERATIONS: readonly PageReadOperation[] = ["lookup", "summarize", "metadata"];

/** The operation the channel serves for a request, or null when it supports none it accepts. */
const servedOperation = (
  request: Exclude<PageReadRequest, "transform">,
  supportedOperations: readonly PageReadOperation[],
): PageReadOperation | null =>
  (request === "context" ? CONTEXT_OPERATIONS : [request])
    .find((operation) => supportedOperations.includes(operation)) ?? null;

export const evaluatePageReadGate = (
  merged: MergedPageReadDecision,
  capability: PageReadCapability | null,
): PageReadGateOutcome => {
  if (!merged.decision.required) {
    return { kind: "not_required" };
  }
  if (!capability?.available) {
    return { kind: "unavailable" };
  }
  if (merged.decision.operation === "transform") {
    return { kind: "unsupported_operation" };
  }
  const operation = servedOperation(merged.decision.operation, capability.supportedOperations);
  if (!operation) {
    return { kind: "unavailable" };
  }
  return {
    kind: "capture",
    operation,
    resolvedRequest: merged.decision.resolvedRequest,
  };
};
