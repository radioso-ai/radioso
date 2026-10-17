import { buildEdgeFactsHeaders } from '../../../../../../../../../lib/server/edge-facts'
import {
  forwardingHeaders,
  publicChatPreflight,
  relayVisitorSessionHeaders,
  visitorSessionHeaders,
  withPublicChatCorsHeaders,
} from '../../../../../../../../../lib/server/public-chat-relay'
import { relayRateLimitResponseHeaders } from '../../../../../../../../../lib/server/rate-limit-headers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BACKEND_BASE = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:8080'

/** The preflight a page's report needs; whether the origin may read the answer is the backend's call. */
export async function OPTIONS(request: Request) {
  return publicChatPreflight(request)
}

/**
 * Relays a page's report of the vendor's id for a voice session it opened, the way the session
 * start travels: the page's origin, cookies and visitor session, and the backend's answer, CORS
 * decision, visitor session headers and rate-limit headers back. Only the documented body field
 * travels.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ token: string; sessionKey: string }> },
) {
  const { token, sessionKey } = await context.params
  const parsedBody: unknown = await request.json().catch(() => ({}))
  const vendorConversationId = parsedBody && typeof parsedBody === 'object' && 'vendorConversationId' in parsedBody
    ? parsedBody.vendorConversationId
    : undefined

  const upstreamMethod = 'POST'
  const upstreamPath = `/api/v1/public/chat/${encodeURIComponent(token)}/voice/sessions/${encodeURIComponent(sessionKey)}/vendor-conversation`

  try {
    const upstream = await fetch(`${BACKEND_BASE}${upstreamPath}`, {
      method: upstreamMethod,
      headers: {
        'Content-Type': 'application/json',
        ...forwardingHeaders(request),
        ...visitorSessionHeaders(request),
        ...buildEdgeFactsHeaders(request, { method: upstreamMethod, path: upstreamPath }),
      },
      body: JSON.stringify(vendorConversationId === undefined ? {} : { vendorConversationId }),
      cache: 'no-store',
    })

    const responseHeaders = new Headers({ 'Cache-Control': 'no-store' })
    const contentType = upstream.headers.get('content-type')
    if (contentType) responseHeaders.set('Content-Type', contentType)
    relayVisitorSessionHeaders(upstream.headers, responseHeaders)
    relayRateLimitResponseHeaders(upstream.headers, responseHeaders)

    return new Response(upstream.status === 204 ? null : upstream.body, {
      status: upstream.status,
      headers: withPublicChatCorsHeaders(responseHeaders, upstream.headers.get('access-control-allow-origin')),
    })
  } catch {
    return Response.json(
      { error: { code: 'service_unavailable', message: 'The report could not be delivered. Try again later.' } },
      { status: 503, headers: withPublicChatCorsHeaders({ 'Cache-Control': 'no-store' }, null) },
    )
  }
}
