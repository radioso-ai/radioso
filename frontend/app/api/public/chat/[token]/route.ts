import type { components } from '../../../../../../typescript-sdk/src/generated/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BACKEND_BASE = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:8080'
const ANONYMOUS_SESSION_HEADER = 'x-radioso-anonymous-session'
const PUBLIC_SESSION_HEADER = 'x-radioso-public-session'
const CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'OPTIONS, POST',
  'Access-Control-Allow-Headers': 'Content-Type, X-Radioso-Public-Session',
  Vary: 'Origin',
}

type PublicChatRequest = components['schemas']['PublicChatRequest']

type PublicChatProxyRequestBody = Partial<PublicChatRequest> & {
  query?: string
  bootstrapGreeting?: boolean
}

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

const firstHeaderValue = (value: string | null) => value?.split(',')[0]?.trim() || null

const resolveRequestForwardingHeaders = (request: Request) => {
  const url = new URL(request.url)
  return {
    host: firstHeaderValue(request.headers.get('x-forwarded-host')) ?? url.host,
    proto: firstHeaderValue(request.headers.get('x-forwarded-proto')) ?? url.protocol.replace(/:$/, ''),
  }
}

const withCorsHeaders = (
  origin: string | null,
  headers?: HeadersInit,
  options: { allowOrigin?: boolean; responseOrigin?: string | null } = {},
) => {
  const nextHeaders = new Headers(headers)
  Object.entries(CORS_HEADERS).forEach(([key, value]) => nextHeaders.set(key, value))
  const allowOrigin = options.allowOrigin ?? true
  const responseOrigin = options.responseOrigin ?? origin
  if (responseOrigin && allowOrigin) {
    nextHeaders.set('Access-Control-Allow-Origin', responseOrigin)
  }
  return nextHeaders
}

export async function OPTIONS(request: Request) {
  const origin = resolveOrigin(request.headers.get('origin'))
  return new Response(null, {
    status: 204,
    headers: withCorsHeaders(origin),
  })
}

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params
  const requestOrigin = resolveOrigin(request.headers.get('origin'))
  const cookie = request.headers.get('cookie')
  const anonymousSession = request.headers.get(ANONYMOUS_SESSION_HEADER)
  const publicSession = request.headers.get(PUBLIC_SESSION_HEADER)
  const forwarding = resolveRequestForwardingHeaders(request)
  const rawBody = await request.text()
  const parsedBody = rawBody ? JSON.parse(rawBody) as PublicChatProxyRequestBody : {}
  const body = JSON.stringify({
    conversationId: parsedBody.conversationId,
    message: parsedBody.message ?? parsedBody.query,
    startConversation: parsedBody.startConversation ?? parsedBody.bootstrapGreeting,
    stream: parsedBody.stream,
    userExpectedLocale: parsedBody.userExpectedLocale,
    inputMetadata: parsedBody.inputMetadata,
    pageContext: parsedBody.pageContext,
  })

  try {
    const upstream = await fetch(`${BACKEND_BASE}/api/v1/public/chat/${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Prefix': '/backend',
        'X-Forwarded-Host': forwarding.host,
        'X-Forwarded-Proto': forwarding.proto,
        ...(requestOrigin ? { Origin: requestOrigin } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(anonymousSession ? { 'X-Radioso-Anonymous-Session': anonymousSession } : {}),
        ...(publicSession ? { 'X-Radioso-Public-Session': publicSession } : {}),
      },
      body,
      cache: 'no-store',
    })

    const headers = withCorsHeaders(requestOrigin, {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
      'Cache-Control': upstream.headers.get('cache-control') ?? 'no-cache',
      'X-Accel-Buffering': upstream.headers.get('x-accel-buffering') ?? 'no',
    }, {
      allowOrigin: Boolean(upstream.headers.get('access-control-allow-origin')),
      responseOrigin: upstream.headers.get('access-control-allow-origin'),
    })

    const anonymousSessionResponse = upstream.headers.get('x-radioso-anonymous-session')
    if (anonymousSessionResponse) {
      headers.set('X-Radioso-Anonymous-Session', anonymousSessionResponse)
    }

    const setCookie = upstream.headers.get('set-cookie')
    if (setCookie) {
      headers.set('Set-Cookie', setCookie)
    }

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
          code: 'UPSTREAM_UNAVAILABLE',
          message,
        },
      },
      { status: 503, headers: withCorsHeaders(requestOrigin) },
    )
  }
}
