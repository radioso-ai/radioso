import { isEnvelopeTimestampFresh, signEnvelope, verifyEnvelope } from "./envelope.js";

const EDGE_FACTS_CONTEXT = "radioso:edge-facts:v1";
const USER_AGENT_CAP = 512;
const ACCEPT_LANGUAGE_CAP = 256;

export const EDGE_FACTS_HEADERS = {
  marker: "x-radioso-edge",
  facts: "x-radioso-edge-facts",
  signature: "x-radioso-edge-signature",
  timestamp: "x-radioso-edge-timestamp",
} as const;

export interface EdgeRequestFacts {
  clientIp: string | null;
  geoHeaders: Record<string, string>;
  userAgent: string | null;
  acceptLanguage: string | null;
}

export type EdgeFactsVerification =
  | { ok: true; facts: EdgeRequestFacts }
  | { ok: false; reason: "expired" | "malformed" | "missing" | "signature" };

const capString = (value: string | null, maxLength: number): string | null =>
  value === null ? null : value.slice(0, maxLength);

const normalizeEdgeRequestFacts = (facts: EdgeRequestFacts): EdgeRequestFacts => ({
  clientIp: facts.clientIp,
  geoHeaders: { ...facts.geoHeaders },
  userAgent: capString(facts.userAgent, USER_AGENT_CAP),
  acceptLanguage: capString(facts.acceptLanguage, ACCEPT_LANGUAGE_CAP),
});

/**
 * Deterministic JSON form of a facts payload: sorted keys (both top-level and
 * within `geoHeaders`, which is also lower-cased), with the length caps
 * applied first. Two callers building the same facts in a different order
 * produce byte-identical output, which is what the signature is computed over.
 */
export const canonicalizeEdgeRequestFacts = (facts: EdgeRequestFacts): string => {
  const normalized = normalizeEdgeRequestFacts(facts);
  const lowerCasedGeoHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(normalized.geoHeaders)) {
    lowerCasedGeoHeaders[name.toLowerCase()] = value;
  }
  const geoHeaders: Record<string, string> = {};
  for (const name of Object.keys(lowerCasedGeoHeaders).sort()) {
    geoHeaders[name] = lowerCasedGeoHeaders[name];
  }

  return JSON.stringify({
    acceptLanguage: normalized.acceptLanguage,
    clientIp: normalized.clientIp,
    geoHeaders,
    userAgent: normalized.userAgent,
  });
};

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const isStringRecord = (value: unknown): value is Record<string, string> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
  && Object.values(value as Record<string, unknown>).every((entry) => typeof entry === "string");

const narrowEdgeRequestFacts = (value: unknown): EdgeRequestFacts | null => {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (!isNullableString(candidate.clientIp)) return null;
  if (!isNullableString(candidate.userAgent)) return null;
  if (!isNullableString(candidate.acceptLanguage)) return null;
  if (!isStringRecord(candidate.geoHeaders)) return null;
  return {
    clientIp: candidate.clientIp,
    userAgent: candidate.userAgent,
    acceptLanguage: candidate.acceptLanguage,
    geoHeaders: candidate.geoHeaders,
  };
};

const decodeFactsHeader = (encoded: string): EdgeRequestFacts | null => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  return narrowEdgeRequestFacts(decoded);
};

/**
 * Signs the caller's observed request facts (capped and canonicalised first)
 * and returns the headers to attach to the forwarded request. Does not set
 * the `marker` header — whether and how a caller identifies itself as the
 * edge that produced this proof is that caller's own decision.
 */
export const createEdgeFactsProof = (input: {
  facts: EdgeRequestFacts;
  method: string;
  now?: Date;
  path: string;
  secret: string;
}): { headers: Record<string, string> } => {
  const normalized = normalizeEdgeRequestFacts(input.facts);
  const payload = canonicalizeEdgeRequestFacts(normalized);
  const { signature, timestamp } = signEnvelope({
    context: EDGE_FACTS_CONTEXT,
    method: input.method,
    path: input.path,
    secret: input.secret,
    payload,
    now: input.now,
  });

  return {
    headers: {
      [EDGE_FACTS_HEADERS.facts]: Buffer.from(JSON.stringify(normalized), "utf8").toString("base64url"),
      [EDGE_FACTS_HEADERS.signature]: signature,
      [EDGE_FACTS_HEADERS.timestamp]: timestamp,
    },
  };
};

export const verifyEdgeFactsProof = (input: {
  headers: Record<string, string | undefined>;
  maxAgeMs?: number;
  method: string;
  now?: Date;
  path: string;
  secret: string;
}): EdgeFactsVerification => {
  const factsHeader = input.headers[EDGE_FACTS_HEADERS.facts];
  const signatureHeader = input.headers[EDGE_FACTS_HEADERS.signature];
  const timestampHeader = input.headers[EDGE_FACTS_HEADERS.timestamp];
  if (!factsHeader || !signatureHeader || !timestampHeader) {
    return { ok: false, reason: "missing" };
  }

  const facts = decodeFactsHeader(factsHeader);
  if (!facts) {
    return { ok: false, reason: "malformed" };
  }

  if (!isEnvelopeTimestampFresh(timestampHeader, { maxAgeMs: input.maxAgeMs, now: input.now })) {
    return { ok: false, reason: "expired" };
  }

  const verified = verifyEnvelope({
    context: EDGE_FACTS_CONTEXT,
    method: input.method,
    path: input.path,
    secret: input.secret,
    payload: canonicalizeEdgeRequestFacts(facts),
    signature: signatureHeader,
    timestamp: timestampHeader,
    now: input.now,
    maxAgeMs: input.maxAgeMs,
  });
  if (!verified) {
    return { ok: false, reason: "signature" };
  }

  return { ok: true, facts };
};
