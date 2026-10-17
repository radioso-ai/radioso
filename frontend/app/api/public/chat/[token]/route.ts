import type { components } from '../../../../../../typescript-sdk/src/generated/types'
import { buildEdgeFactsHeaders } from '../../../../../lib/server/edge-facts'
import {
  PUBLIC_CHAT_RELAY_UNAVAILABLE_CODE,
  forwardingHeaders,
  publicChatPreflight,
  relayVisitorSessionHeaders,
  resolveRequestOrigin,
  visitorSessionHeaders,
  withPublicChatCorsHeaders,
} from '../../../../../lib/server/public-chat-relay'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BACKEND_BASE = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:8080'

type PublicChatRequest = components['schemas']['PublicChatRequest']

type PublicChatProxyRequestBody = Partial<PublicChatRequest> & {
  query?: string
  bootstrapGreeting?: boolean
  clientContextCapabilities?: unknown
}

export async function OPTIONS(request: Request) {
  return publicChatPreflight(request)
}

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params
  const requestOrigin = resolveRequestOrigin(request.headers.get('origin'))
  const rawBody = await request.text()
  const parsedBody = rawBody ? JSON.parse(rawBody) as PublicChatProxyRequestBody : {}
  const body = JSON.stringify({
    conversationId: parsedBody.conversationId,
    bootstrapGreetingId: parsedBody.bootstrapGreetingId,
    message: parsedBody.message ?? parsedBody.query,
    startConversation: parsedBody.startConversation ?? parsedBody.bootstrapGreeting,
    stream: parsedBody.stream,
    userExpectedLocale: parsedBody.userExpectedLocale,
    inputMetadata: parsedBody.inputMetadata,
    pageContext: parsedBody.pageContext,
    clientContextCapabilities: parsedBody.clientContextCapabilities,
  })

  const upstreamMethod = 'POST'
  const upstreamPath = `/api/v1/public/chat/${encodeURIComponent(token)}`

  try {
    const upstream = await fetch(`${BACKEND_BASE}${upstreamPath}`, {
      method: upstreamMethod,
      headers: {
        'Content-Type': 'application/json',
        ...forwardingHeaders(request),
        ...visitorSessionHeaders(request),
        ...buildEdgeFactsHeaders(request, { method: upstreamMethod, path: upstreamPath }),
      },
      body,
      cache: 'no-store',
    })

    const headers = withPublicChatCorsHeaders({
      'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
      'Cache-Control': upstream.headers.get('cache-control') ?? 'no-cache',
      'X-Accel-Buffering': upstream.headers.get('x-accel-buffering') ?? 'no',
    }, upstream.headers.get('access-control-allow-origin'))
    relayVisitorSessionHeaders(upstream.headers, headers)

    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    })
  } catch (error) {
    const message =
      error instanceof Error
        ? `Public chat backend is unavailable: ${error.message}`
        : 'Public chat backend is unavailable.'

    return Response.json(
      {
        error: {
          code: PUBLIC_CHAT_RELAY_UNAVAILABLE_CODE,
          message,
        },
      },
      { status: 503, headers: withPublicChatCorsHeaders(undefined, requestOrigin) },
    )
  }
}
