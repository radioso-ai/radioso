export {
  DEFAULT_ENVELOPE_MAX_AGE_MS,
  isEnvelopeTimestampFresh,
  resolveTrustedForwardedAddress,
  signEnvelope,
  verifyEnvelope,
} from "./envelope.js";
export type { EnvelopeProof } from "./envelope.js";

export {
  canonicalizeEdgeRequestFacts,
  createEdgeFactsProof,
  EDGE_FACTS_HEADERS,
  verifyEdgeFactsProof,
} from "./edgeFacts.js";
export type { EdgeFactsVerification, EdgeRequestFacts } from "./edgeFacts.js";

export { collectGeoHeaders, WELL_KNOWN_GEO_HEADERS } from "./geoHeaders.js";
