import {
  EDGE_FACTS_HEADERS,
  resolveTrustedForwardedAddress,
  verifyEdgeFactsProof,
  type EdgeFactsVerification,
  type EdgeRequestFacts,
} from "@radioso/edge-proof";

/** Mirrors `EdgeFactsVerification`'s failure reasons (spec 1277 Observability: `edge_facts_proof_rejected_total{reason}`). */
export type EdgeFactsRejectionReason = Exclude<EdgeFactsVerification, { ok: true }>["reason"];

type IncomingHeaderValue = string | readonly string[] | undefined;
/** Plain Node request headers, so callers hand in values rather than an Express `Request`. */
export type IncomingHeaders = Record<string, IncomingHeaderValue>;

/**
 * What a request says about the first-party edge that relayed it: no edge
 * marker at all, a marker whose signed facts verified, or a marker that
 * failed to prove itself.
 */
type EdgeFactsEnvelopeReading =
  | { status: "absent" }
  | { status: "verified"; facts: EdgeRequestFacts }
  | { status: "rejected"; reason: EdgeFactsRejectionReason };

export const singleHeader = (value: IncomingHeaderValue): string | null => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
};

export const readEdgeFactsEnvelope = (input: {
  headers: IncomingHeaders;
  /** `RADIOSO_EDGE_PROOF_SECRET`; unset means an edge marker can never verify. */
  secret: string | undefined;
  method: string;
  path: string;
  now?: Date;
}): EdgeFactsEnvelopeReading => {
  if (!singleHeader(input.headers[EDGE_FACTS_HEADERS.marker])) {
    return { status: "absent" };
  }
  if (!input.secret) {
    return { status: "rejected", reason: "missing" };
  }

  const verification = verifyEdgeFactsProof({
    headers: {
      [EDGE_FACTS_HEADERS.facts]: singleHeader(input.headers[EDGE_FACTS_HEADERS.facts]) ?? undefined,
      [EDGE_FACTS_HEADERS.signature]: singleHeader(input.headers[EDGE_FACTS_HEADERS.signature]) ?? undefined,
      [EDGE_FACTS_HEADERS.timestamp]: singleHeader(input.headers[EDGE_FACTS_HEADERS.timestamp]) ?? undefined,
    },
    method: input.method,
    path: input.path,
    secret: input.secret,
    now: input.now,
  });

  return verification.ok
    ? { status: "verified", facts: verification.facts }
    : { status: "rejected", reason: verification.reason };
};

/**
 * The envelope carries the raw X-Forwarded-For chain the frontend received,
 * unresolved (the frontend cannot know this backend's own hop count).
 * Resolving it with this backend's `trustedProxyHops` and no socket fallback
 * means a hop count of 0 yields null rather than trusting a caller-controlled
 * entry.
 */
export const resolveEdgeFactsClientAddress = (
  facts: EdgeRequestFacts,
  trustedProxyHops: number,
): string | null => resolveTrustedForwardedAddress({
  forwardedFor: facts.forwardedFor ?? undefined,
  socketAddress: null,
  trustedProxyHops,
});
