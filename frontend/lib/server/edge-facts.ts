import {
  collectGeoHeaders,
  createEdgeFactsProof,
  EDGE_FACTS_HEADERS,
} from '@radioso/edge-proof'

import { getEdgeEnv } from './edge-env'

/**
 * Builds the headers the frontend proxy attaches to every upstream backend
 * fetch (spec 1277 FR-021): always the `x-radioso-edge: frontend` marker, and
 * — when `RADIOSO_EDGE_PROOF_SECRET` is configured — the signed edge-facts
 * proof headers on top.
 *
 * `method`/`path` MUST be the upstream backend method and path this proxy is
 * about to call (e.g. `/api/v1/public/chat/<token>`), not the inbound
 * Next.js request's own method/path — the backend verifies the proof against
 * its own `req.method` and `req.originalUrl`, so both ends must agree on
 * exactly this string. Passing this proxy's own inbound request path here
 * would make every proof fail signature verification.
 *
 * `forwardedFor`: the raw `X-Forwarded-For` header value as received by this
 * proxy, unresolved. Next.js's `Request` exposes no socket address and this
 * proxy has no basis to decide which entry in that chain is trustworthy —
 * only the backend knows its own `RADIOSO_TRUSTED_PROXY_HOPS`, and it resolves
 * the trusted suffix once the raw chain reaches it in the signed envelope.
 */
export const buildEdgeFactsHeaders = (
  request: Request,
  upstream: { method: string; path: string },
): Record<string, string> => {
  const env = getEdgeEnv()
  const headers: Record<string, string> = { [EDGE_FACTS_HEADERS.marker]: 'frontend' }

  if (!env.RADIOSO_EDGE_PROOF_SECRET) {
    return headers
  }

  const { headers: proofHeaders } = createEdgeFactsProof({
    facts: {
      forwardedFor: request.headers.get('x-forwarded-for'),
      geoHeaders: collectGeoHeaders(request.headers),
      userAgent: request.headers.get('user-agent'),
      acceptLanguage: request.headers.get('accept-language'),
    },
    method: upstream.method,
    path: upstream.path,
    secret: env.RADIOSO_EDGE_PROOF_SECRET,
  })

  return { ...headers, ...proofHeaders }
}
