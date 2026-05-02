export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BACKEND_BASE = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:8080'
const ANONYMOUS_SESSION_HEADER = 'x-radioso-anonymous-session'
const PUBLIC_SESSION_HEADER = 'x-radioso-public-session'

interface PublicChatProxyRequestBody {
  message?: string
  query?: string
  stream?: boolean
  conversationId?: string
  startConversation?: boolean
  bootstrapGreeting?: boolean
  userExpectedLocale?: string
  inputMetadata?: unknown
  pageContext?: unknown
}

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params
  const cookie = request.headers.get('cookie')
  const anonymousSession = request.headers.get(ANONYMOUS_SESSION_HEADER)
  const publicSession = request.headers.get(PUBLIC_SESSION_HEADER)
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
        ...(cookie ? { Cookie: cookie } : {}),
        ...(anonymousSession ? { 'X-Radioso-Anonymous-Session': anonymousSession } : {}),
        ...(publicSession ? { 'X-Radioso-Public-Session': publicSession } : {}),
      },
      body,
      cache: 'no-store',
    })

    const headers = new Headers({
      'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
      'Cache-Control': upstream.headers.get('cache-control') ?? 'no-cache',
      'X-Accel-Buffering': upstream.headers.get('x-accel-buffering') ?? 'no',
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
      { status: 503 },
    )
  }
}
