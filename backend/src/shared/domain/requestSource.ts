import { resolveTrustedForwardedAddress } from "@radioso/edge-proof";

import {
  resolveEdgeFactsClientAddress,
  type EdgeFactsEnvelopeReading,
  type IncomingHeaders,
} from "./edgeFactsEnvelope.js";

interface ResolveRequestSourceAddressInput {
  headers: IncomingHeaders;
  socketAddress: string | null;
  /** `RADIOSO_TRUSTED_PROXY_HOPS`, applied to a verified envelope's chain and to the request's own. */
  trustedProxyHops: number;
  /** This request's edge-facts envelope, read once by the caller with `readEdgeFactsEnvelope`. */
  envelope: EdgeFactsEnvelopeReading;
}

/**
 * The request source: the best attributable client address of an inbound
 * request, or null when there is none. A first-party edge's verified
 * envelope wins, because the chain it carries ends with the visitor its own
 * ingress observed, while the chain the backend receives through that edge
 * has the edge's egress hop appended. Otherwise the backend's own observation
 * stands.
 *
 * An edge marker that fails to verify is ignored here rather than nulling the
 * result, unlike `deriveConversationRequestContext`: recording visitor facts
 * must never trust an unproven claim, but budgeting still has the backend's
 * own attributable observation to key on.
 */
export const resolveRequestSourceAddress = (input: ResolveRequestSourceAddressInput): string | null => {
  if (input.envelope.status === "verified") {
    const address = resolveEdgeFactsClientAddress(input.envelope.facts, input.trustedProxyHops);
    if (address) return address;
  }

  return resolveTrustedForwardedAddress({
    forwardedFor: input.headers["x-forwarded-for"],
    socketAddress: input.socketAddress,
    trustedProxyHops: input.trustedProxyHops,
  });
};
