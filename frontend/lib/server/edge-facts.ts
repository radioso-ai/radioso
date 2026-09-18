import {
  collectGeoHeaders,
  createEdgeFactsProof,
  EDGE_FACTS_HEADERS,
  resolveTrustedForwardedAddress,
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
 * `clientIp`: Next.js's `Request` exposes no socket address, so there is no
 * value this proxy itself observed the connection on. When `trustedProxyHops`
 * is 0, `resolveTrustedForwardedAddress` has nothing trustworthy to fall back
 * to and correctly returns `null` — this deliberately does NOT read the first
 * `X-Forwarded-For` entry, which is caller-controlled and unverifiable at
 * hops=0. The backend records a `null` clientIp for that case rather than
 * trusting an address neither end can verify.
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

  const extraGeoHeaderNames = [
    env.VISITOR_GEO_COUNTRY_HEADER,
    env.VISITOR_GEO_REGION_HEADER,
    env.VISITOR_GEO_CITY_HEADER,
  ].filter((name): name is string => Boolean(name))

  const { headers: proofHeaders } = createEdgeFactsProof({
    facts: {
      clientIp: resolveTrustedForwardedAddress({
        forwardedFor: request.headers.get('x-forwarded-for') ?? undefined,
        socketAddress: null,
        trustedProxyHops: env.RADIOSO_TRUSTED_PROXY_HOPS,
      }),
      geoHeaders: collectGeoHeaders(request.headers, extraGeoHeaderNames),
      userAgent: request.headers.get('user-agent'),
      acceptLanguage: request.headers.get('accept-language'),
    },
    method: upstream.method,
    path: upstream.path,
    secret: env.RADIOSO_EDGE_PROOF_SECRET,
  })

  return { ...headers, ...proofHeaders }
}
