import type { TurnDeclineReason } from "./assistantTurnOutcomeTypes.js";
import type { GroundedAnswerEnvelope, GroundingEnvelopeParseStatus } from "./groundedAnswerEnvelope.js";
import type { GroundingVerdict } from "../../../shared/domain/groundingDiagnostic.js";

/**
 * How well evidence supported the answer. Scope is deliberately *not* a verdict here:
 * an out-of-scope decline is as unsupported as any other decline, so it computes to
 * `no_support` and carries its reason on {@link GroundingSummary.declineReason}.
 */
export type { GroundingVerdict };

export interface GroundingSummary {
  protocolVersion: 1 | 2 | null;
  parseStatus: GroundingEnvelopeParseStatus;
  verdict: GroundingVerdict;
  claimCount: number;
  sourcedClaimCount: number;
  unsourcedClaimCount: number;
  invalidSourceCount: number;
  assertionMismatch: boolean;
  /** Present only on a `no_support` verdict: why the turn declined. */
  declineReason?: TurnDeclineReason;
}

export interface ParsedInlineAssertions {
  groups: number[][];
  invalidSourceCount: number;
}

const COMPLETE_ASSERTION = /\[\[([^\]]*)\]\]/g;

const readManifestPositiveInteger = (value: unknown): number | null => {
  const numeric = typeof value === "string" && /^\d+$/.test(value.trim())
    ? Number(value.trim())
    : value;
  return typeof numeric === "number" && Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
};

const readInlinePositiveInteger = (value: unknown): number | null => {
  const numeric = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof numeric === "number" && Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
};

const normalizeSources = (
  rawSources: readonly unknown[],
  contextCount: number,
  readSource: (value: unknown) => number | null = readManifestPositiveInteger,
): { sources: number[]; invalidSourceCount: number } => {
  const sources: number[] = [];
  let invalidSourceCount = 0;

  for (const rawSource of rawSources) {
    const source = readSource(rawSource);
    if (source === null || source > contextCount) {
      invalidSourceCount += 1;
      continue;
    }
    if (!sources.includes(source)) {
      sources.push(source);
    }
  }

  return { sources, invalidSourceCount };
};

export const parseInlineAssertionGroups = (
  body: string,
  contextCount: number,
): ParsedInlineAssertions => {
  const tokens = [...body.matchAll(COMPLETE_ASSERTION)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    value: match[1] ?? "",
  }));
  const groups: number[][] = [];
  const assertionStarts = body.match(/\[\[/g)?.length ?? 0;
  let invalidSourceCount = Math.max(0, assertionStarts - tokens.length);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.value === "?") {
      groups.push([]);
      continue;
    }

    const rawSources: unknown[] = [token.value];
    let end = token.end;
    while (index + 1 < tokens.length) {
      const next = tokens[index + 1]!;
      if (!/^[ \t]*$/.test(body.slice(end, next.start)) || next.value === "?") {
        break;
      }
      rawSources.push(next.value);
      end = next.end;
      index += 1;
    }

    const normalized = normalizeSources(rawSources, contextCount, readInlinePositiveInteger);
    invalidSourceCount += normalized.invalidSourceCount;
    groups.push(normalized.sources);
  }

  return { groups, invalidSourceCount };
};

const normalizeManifest = (
  claims: unknown[][],
  contextCount: number,
): ParsedInlineAssertions => {
  const groups: number[][] = [];
  let invalidSourceCount = 0;
  for (const claim of claims) {
    const normalized = normalizeSources(claim, contextCount);
    groups.push(normalized.sources);
    invalidSourceCount += normalized.invalidSourceCount;
  }
  return { groups, invalidSourceCount };
};

const sameGroups = (left: number[][], right: number[][]): boolean =>
  left.length === right.length
  && left.every((group, groupIndex) => {
    const candidate = right[groupIndex];
    return candidate !== undefined
      && group.length === candidate.length
      && group.every((source, sourceIndex) => source === candidate[sourceIndex]);
  });

export const hasValidSourcedAssertion = (body: string, contextCount: number): boolean =>
  parseInlineAssertionGroups(body, contextCount).groups.some((group) => group.length > 0);

export const computeGroundingSummary = (input: {
  body: string;
  envelope: Pick<
    GroundedAnswerEnvelope,
    "protocolVersion" | "parseStatus" | "outcome" | "claims" | "suggestions"
  >;
  contextCount: number;
}): GroundingSummary => {
  const inline = parseInlineAssertionGroups(input.body, input.contextCount);
  const manifest = normalizeManifest(input.envelope.claims, input.contextCount);
  const assertionMismatch = input.envelope.parseStatus === "valid_v2"
    ? !sameGroups(inline.groups, manifest.groups)
    : false;
  const claimCount = inline.groups.length;
  const sourcedClaimCount = inline.groups.filter((group) => group.length > 0).length;
  const unsourcedClaimCount = inline.groups.filter((group) => group.length === 0).length;
  const invalidSourceCount = inline.invalidSourceCount + manifest.invalidSourceCount;

  let verdict: GroundingVerdict = "degraded";
  let declineReason: TurnDeclineReason | undefined;
  if (input.envelope.parseStatus === "valid_v2" && !assertionMismatch && invalidSourceCount === 0) {
    if (
      (input.envelope.outcome === "no_support" || input.envelope.outcome === "out_of_scope")
      && sourcedClaimCount === 0
      && input.envelope.suggestions.length === 0
    ) {
      verdict = "no_support";
      declineReason = input.envelope.outcome === "out_of_scope" ? "out_of_scope" : "content_gap";
    } else if (
      input.envelope.outcome === "answer"
      && claimCount > 0
      && sourcedClaimCount === claimCount
      && unsourcedClaimCount === 0
    ) {
      verdict = "grounded";
    }
  }

  return {
    protocolVersion: input.envelope.protocolVersion,
    parseStatus: input.envelope.parseStatus,
    verdict,
    claimCount,
    sourcedClaimCount,
    unsourcedClaimCount,
    invalidSourceCount,
    assertionMismatch,
    ...(declineReason ? { declineReason } : {}),
  };
};
