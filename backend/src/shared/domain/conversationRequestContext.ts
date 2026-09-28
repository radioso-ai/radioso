import { collectGeoHeaders, resolveTrustedForwardedAddress } from "@radioso/edge-proof";
import type { ConversationRequestContext } from "@radioso/conversation-contract";

import {
  readEdgeFactsEnvelope,
  resolveEdgeFactsClientAddress,
  singleHeader,
  type EdgeFactsEnvelopeReading,
  type EdgeFactsRejectionReason,
  type IncomingHeaders,
} from "./edgeFactsEnvelope.js";
import type { VisitorGeoResolver } from "./visitorGeoResolver.js";

const USER_AGENT_CAP = 512;
const ACCEPT_LANGUAGE_CAP = 256;

interface DeriveConversationRequestContextInput {
  headers: IncomingHeaders;
  socketAddress: string | null;
  /**
   * `RADIOSO_TRUSTED_PROXY_HOPS`: this backend's own hop count, applied both
   * to a request it observed directly and to the raw `X-Forwarded-For` chain
   * a verified edge-proof envelope forwarded (see the `edge_proof` branch
   * below). On Cloud Run one hop count is correct for both: the frontend is a
   * Cloud Run service too, and each service's front end appends exactly the
   * peer that connected to it, so the chain the frontend received ends with
   * the visitor just as a direct caller's chain ends with that caller.
   */
  trustedProxyHops: number;
  /** `RADIOSO_EDGE_PROOF_SECRET`; unset means an edge marker can never verify. */
  secret: string | undefined;
  method: string;
  path: string;
  /**
   * This request's envelope as `readEdgeFactsEnvelope` already read it (the
   * request-source middleware publishes one); read from `headers` when absent.
   */
  envelope?: EdgeFactsEnvelopeReading;
  geoResolver: VisitorGeoResolver;
  now?: Date;
}

export interface DeriveConversationRequestContextResult {
  context: ConversationRequestContext;
  /** Present only for the "marker present, proof missing or invalid" case (FR-023). */
  rejection?: EdgeFactsRejectionReason;
}

const capString = (value: string | null, maxLength: number): string | null =>
  value === null ? null : value.slice(0, maxLength);

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
  const envelope = input.envelope ?? readEdgeFactsEnvelope(input);
  if (envelope.status === "rejected") {
    return { context: nullFacts("unproven"), rejection: envelope.reason };
  }
  if (envelope.status === "verified") {
    const geo = input.geoResolver.resolve(envelope.facts.geoHeaders);
    return {
      context: {
        clientIp: resolveEdgeFactsClientAddress(envelope.facts, input.trustedProxyHops),
        country: geo.country,
        region: geo.region,
        city: geo.city,
        userAgent: capString(envelope.facts.userAgent, USER_AGENT_CAP),
        acceptLanguage: capString(envelope.facts.acceptLanguage, ACCEPT_LANGUAGE_CAP),
        observedVia: "edge_proof",
      },
    };
  }

  const clientIp = resolveTrustedForwardedAddress({
    forwardedFor: input.headers["x-forwarded-for"],
    socketAddress: input.socketAddress,
    trustedProxyHops: input.trustedProxyHops,
  });
  const geoHeaders = collectGeoHeaders(input.headers);
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
