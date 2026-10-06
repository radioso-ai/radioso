import { buildEdgeFactsHeaders } from '../../../../../lib/server/edge-facts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BACKEND_BASE =
  process.env.RADIOSO_API_INTERNAL_URL ??
  process.env.BACKEND_INTERNAL_URL ??
  'http://localhost:8080'

// Embed config is cacheable but gated per origin: the backend only returns it to
// allow-listed sites, and the response is reflected back to the requesting
// origin. A CDN must therefore include `Origin` in its cache key (see infra
// cdn_policy). The response no longer depends on Accept-Language — built-in
// locale packs are resolved client-side in the launcher.
const BASE_CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'OPTIONS, GET',
  'Access-Control-Allow-Headers': 'Content-Type',
  Vary: 'Origin',
}
const RATE_LIMIT_RESPONSE_HEADER_NAMES = [
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'retry-after',
] as const

const rateLimitResponseHeaders = (upstream: Response): Record<string, string> => {
  const headers: Record<string, string> = {}

  for (const name of RATE_LIMIT_RESPONSE_HEADER_NAMES) {
    const value = upstream.headers.get(name)
    if (value) {
      headers[name] = value
    }
  }

  return headers
}

// Short browser TTL, modest shared/edge TTL. Operator settings changes propagate
// immediately via CDN cache invalidation on save, so we don't need a long
// serve-stale window here.
const CDN_CACHE_CONTROL = 'public, max-age=60, s-maxage=300'

const resolveOrigin = (value: string | null) => {
  if (!value) {
    return null
  }
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

const corsHeaders = (origin: string | null, extra?: Record<string, string>) => {
  const headers: Record<string, string> = { ...BASE_CORS_HEADERS, ...extra }
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}

export async function OPTIONS(request: Request) {
  const origin = resolveOrigin(request.headers.get('origin'))
  return new Response(null, { status: 204, headers: corsHeaders(origin) })
}

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params
  const requestOrigin = resolveOrigin(request.headers.get('origin'))
  const upstreamMethod = 'GET'
  const upstreamPath = `/api/v1/public/chat/${encodeURIComponent(token)}/embed-config`

  try {
    const upstream = await fetch(`${BACKEND_BASE}${upstreamPath}`, {
      method: upstreamMethod,
      cache: 'no-store',
      headers: {
        'X-Forwarded-Prefix': '/backend',
        ...(requestOrigin ? { Origin: requestOrigin } : {}),
        ...buildEdgeFactsHeaders(request, { method: upstreamMethod, path: upstreamPath }),
      },
    })
    const contentType = upstream.headers.get('content-type') ?? 'application/json'

    return new Response(upstream.body, {
      status: upstream.status,
      // Only reflect the origin (and allow caching) when the backend accepted
      // it. A rejected origin gets no `Access-Control-Allow-Origin` and is never
      // cached.
      headers: corsHeaders(upstream.ok ? requestOrigin : null, {
        'Content-Type': contentType,
        'Cache-Control': upstream.ok ? CDN_CACHE_CONTROL : 'no-store',
        ...rateLimitResponseHeaders(upstream),
      }),
    })
  } catch (error) {
    const message =
      error instanceof Error
        ? `Embedded chat backend is unavailable: ${error.message}`
        : 'Embedded chat backend is unavailable.'

    return Response.json(
      {
        error: {
          code: 'upstream_unavailable',
          message,
        },
      },
      { status: 503, headers: corsHeaders(null, { 'Cache-Control': 'no-store' }) },
    )
  }
}
