import {
  collectGeoHeaders,
  EDGE_FACTS_HEADERS,
  resolveTrustedForwardedAddress,
  verifyEdgeFactsProof,
  type EdgeFactsVerification,
} from "@radioso/edge-proof";
import type { ConversationRequestContext } from "@radioso/conversation-contract";

import type { VisitorGeoResolver } from "./visitorGeoResolver.js";

const USER_AGENT_CAP = 512;
const ACCEPT_LANGUAGE_CAP = 256;

/** Mirrors `EdgeFactsVerification`'s failure reasons (spec 1277 Observability: `edge_facts_proof_rejected_total{reason}`). */
export type EdgeFactsRejectionReason = Exclude<EdgeFactsVerification, { ok: true }>["reason"];

type IncomingHeaderValue = string | readonly string[] | undefined;
type IncomingHeaders = Record<string, IncomingHeaderValue>;

interface DeriveConversationRequestContextInput {
  headers: IncomingHeaders;
  socketAddress: string | null;
  trustedProxyHops: number;
  /** `RADIOSO_EDGE_PROOF_SECRET`; unset means an edge marker can never verify. */
  secret: string | undefined;
  method: string;
  path: string;
  geoResolver: VisitorGeoResolver;
  /** Operator `VISITOR_GEO_*_HEADER` overrides, so the backend-observed case collects them too (FR-022). */
  extraGeoHeaderNames?: readonly string[];
  now?: Date;
}

export interface DeriveConversationRequestContextResult {
  context: ConversationRequestContext;
  /** Present only for the "marker present, proof missing or invalid" case (FR-023). */
  rejection?: EdgeFactsRejectionReason;
}

const capString = (value: string | null, maxLength: number): string | null =>
  value === null ? null : value.slice(0, maxLength);

const singleHeader = (value: IncomingHeaderValue): string | null => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
};

const nullFacts = (observedVia: ConversationRequestContext["observedVia"]): ConversationRequestContext => ({
  clientIp: null,
  country: null,
  region: null,
  city: null,
  userAgent: null,
  acceptLanguage: null,
  observedVia,
});

/**
 * FR-023: derives the request facts a new conversation is created with, from
 * one of three cases — a first-party edge's valid signed proof, a marker
 * asserting an edge that failed to prove itself (facts stay null; a spoofed
 * marker can only hide a caller, never forge facts), or no marker at all
 * (the backend observed the request itself). Pure and HTTP-framework-neutral:
 * callers hand in plain header/socket values, never an Express `Request`.
 */
export const deriveConversationRequestContext = (
  input: DeriveConversationRequestContextInput,
): DeriveConversationRequestContextResult => {
  const marker = singleHeader(input.headers[EDGE_FACTS_HEADERS.marker]);
  if (marker) {
    if (!input.secret) {
      return { context: nullFacts("unproven"), rejection: "missing" };
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

    if (!verification.ok) {
      return { context: nullFacts("unproven"), rejection: verification.reason };
    }

    const geo = input.geoResolver.resolve(verification.facts.geoHeaders);
    return {
      context: {
        clientIp: verification.facts.clientIp,
        country: geo.country,
        region: geo.region,
        city: geo.city,
        userAgent: capString(verification.facts.userAgent, USER_AGENT_CAP),
        acceptLanguage: capString(verification.facts.acceptLanguage, ACCEPT_LANGUAGE_CAP),
        observedVia: "edge_proof",
      },
    };
  }

  const clientIp = resolveTrustedForwardedAddress({
    forwardedFor: input.headers["x-forwarded-for"],
    socketAddress: input.socketAddress,
    trustedProxyHops: input.trustedProxyHops,
  });
  const geoHeaders = collectGeoHeaders(input.headers, input.extraGeoHeaderNames ?? []);
  const geo = input.geoResolver.resolve(geoHeaders);

  return {
    context: {
      clientIp,
      country: geo.country,
      region: geo.region,
      city: geo.city,
      userAgent: capString(singleHeader(input.headers["user-agent"]), USER_AGENT_CAP),
      acceptLanguage: capString(singleHeader(input.headers["accept-language"]), ACCEPT_LANGUAGE_CAP),
      observedVia: "backend",
    },
  };
};
