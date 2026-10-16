import { buildEdgeFactsHeaders } from '../../../../../../../lib/server/edge-facts'
import { relayRateLimitResponseHeaders } from '../../../../../../../lib/server/rate-limit-headers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BACKEND_BASE = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:8080'
const PUBLIC_SESSION_HEADER = 'x-radioso-public-session'
const CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'OPTIONS, POST',
  'Access-Control-Allow-Headers': 'Content-Type, X-Radioso-Public-Session',
  Vary: 'Origin',
}

const resolveOrigin = (value: string | null) => {
  if (!value) return null
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

const firstHeaderValue = (value: string | null) => value?.split(',')[0]?.trim() || null

const withCorsHeaders = (headers: HeadersInit | undefined, allowOrigin: string | null) => {
  const nextHeaders = new Headers(headers)
  Object.entries(CORS_HEADERS).forEach(([key, value]) => nextHeaders.set(key, value))
  if (allowOrigin) nextHeaders.set('Access-Control-Allow-Origin', allowOrigin)
  return nextHeaders
}

/**
 * The preflight a page's voice session start needs: it sends JSON and the public session header.
 * Whether the origin may read the answer is the backend's call, made on the POST against the
 * website embed's admitted origins, as for a chat message.
 */
export async function OPTIONS(request: Request) {
  return new Response(null, {
    status: 204,
    headers: withCorsHeaders(undefined, resolveOrigin(request.headers.get('origin'))),
  })
}

/**
 * Relays a voice session start from a page on an admitted origin to the backend, with the page's
 * origin and public session, and passes back the backend's answer and its CORS decision. Only the
 * documented body field travels; the response is never cached, since it carries a signed URL.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params
  const requestOrigin = resolveOrigin(request.headers.get('origin'))
  const publicSession = request.headers.get(PUBLIC_SESSION_HEADER)
  const url = new URL(request.url)
  const forwardedHost = firstHeaderValue(request.headers.get('x-forwarded-host')) ?? firstHeaderValue(request.headers.get('host')) ?? url.host
  const forwardedProto = firstHeaderValue(request.headers.get('x-forwarded-proto')) ?? url.protocol.replace(/:$/, '')
  const parsedBody: unknown = await request.json().catch(() => ({}))
  const locale = parsedBody && typeof parsedBody === 'object' && 'locale' in parsedBody ? parsedBody.locale : undefined

  const upstreamMethod = 'POST'
  const upstreamPath = `/api/v1/public/chat/${encodeURIComponent(token)}/voice/sessions`

  try {
    const upstream = await fetch(`${BACKEND_BASE}${upstreamPath}`, {
      method: upstreamMethod,
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Prefix': '/backend',
        'X-Forwarded-Host': forwardedHost,
        'X-Forwarded-Proto': forwardedProto,
        ...(requestOrigin ? { Origin: requestOrigin } : {}),
        ...(publicSession ? { 'X-Radioso-Public-Session': publicSession } : {}),
        ...buildEdgeFactsHeaders(request, { method: upstreamMethod, path: upstreamPath }),
      },
      body: JSON.stringify(locale === undefined ? {} : { locale }),
      cache: 'no-store',
    })

    const responseHeaders = new Headers({
      'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
      'Cache-Control': 'no-store',
    })
    relayRateLimitResponseHeaders(upstream.headers, responseHeaders)

    return new Response(upstream.body, {
      status: upstream.status,
      headers: withCorsHeaders(responseHeaders, upstream.headers.get('access-control-allow-origin')),
    })
  } catch {
    return Response.json(
      { error: { code: 'upstream_unavailable', message: 'Voice sessions are unavailable right now.' } },
      { status: 503, headers: withCorsHeaders({ 'Cache-Control': 'no-store' }, null) },
    )
  }
}
