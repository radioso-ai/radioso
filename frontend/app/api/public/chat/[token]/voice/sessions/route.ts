import { buildEdgeFactsHeaders } from '../../../../../../../lib/server/edge-facts'
import {
  forwardingHeaders,
  publicChatPreflight,
  relayVisitorSessionHeaders,
  visitorSessionHeaders,
  withPublicChatCorsHeaders,
} from '../../../../../../../lib/server/public-chat-relay'
import { relayRateLimitResponseHeaders } from '../../../../../../../lib/server/rate-limit-headers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BACKEND_BASE = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:8080'
/** The backend's code for a session that could not be started, so a page reads one code for it. */
const VOICE_UNAVAILABLE_CODE = 'voice_unavailable'

/**
 * The preflight a page's voice session start needs. Whether the origin may read the answer is the
 * backend's call, made on the POST against the website embed's admitted origins.
 */
export async function OPTIONS(request: Request) {
  return publicChatPreflight(request)
}

/**
 * Relays a voice session start from a page to the backend the way a chat message travels: the
 * page's origin, cookies and visitor session, and the backend's answer, CORS decision, visitor
 * session headers and rate-limit headers back. Only the documented body field travels; the answer
 * is never cached, since it carries a signed URL.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params
  const parsedBody: unknown = await request.json().catch(() => ({}))
  const locale = parsedBody && typeof parsedBody === 'object' && 'locale' in parsedBody ? parsedBody.locale : undefined

  const upstreamMethod = 'POST'
  const upstreamPath = `/api/v1/public/chat/${encodeURIComponent(token)}/voice/sessions`

  try {
    const upstream = await fetch(`${BACKEND_BASE}${upstreamPath}`, {
      method: upstreamMethod,
      headers: {
        'Content-Type': 'application/json',
        ...forwardingHeaders(request),
        ...visitorSessionHeaders(request),
        ...buildEdgeFactsHeaders(request, { method: upstreamMethod, path: upstreamPath }),
      },
      body: JSON.stringify(locale === undefined ? {} : { locale }),
      cache: 'no-store',
    })

    const responseHeaders = new Headers({
      'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
      'Cache-Control': 'no-store',
    })
    relayVisitorSessionHeaders(upstream.headers, responseHeaders)
    relayRateLimitResponseHeaders(upstream.headers, responseHeaders)

    return new Response(upstream.body, {
      status: upstream.status,
      headers: withPublicChatCorsHeaders(responseHeaders, upstream.headers.get('access-control-allow-origin')),
    })
  } catch {
    return Response.json(
      { error: { code: VOICE_UNAVAILABLE_CODE, message: 'The voice session could not be started. Try again later.' } },
      { status: 503, headers: withPublicChatCorsHeaders({ 'Cache-Control': 'no-store' }, null) },
    )
  }
}
