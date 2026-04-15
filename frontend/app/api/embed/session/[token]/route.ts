import { createHmac } from 'node:crypto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BACKEND_BASE = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:8080'
const CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'OPTIONS, POST',
  'Access-Control-Allow-Headers': 'Content-Type',
  Vary: 'Origin',
}

const withCorsHeaders = (origin: string | null, headers?: HeadersInit) => {
  const nextHeaders = new Headers(headers)
  Object.entries(CORS_HEADERS).forEach(([key, value]) => nextHeaders.set(key, value))
  if (origin) {
    nextHeaders.set('Access-Control-Allow-Origin', origin)
  }
  return nextHeaders
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
  const signatureSecret = process.env.SESSION_COOKIE_SECRET

  if (!signatureSecret) {
    return Response.json(
      {
        error: {
          code: 'embed_unavailable',
          message: 'This embedded chat launch could not be verified.',
        },
      },
      { status: 503, headers: withCorsHeaders(requestOrigin) },
    )
  }

  if (!requestOrigin) {
    return Response.json(
      {
        error: {
          code: 'bad_request',
          message: 'Invalid embed session request',
        },
      },
      { status: 400, headers: withCorsHeaders(requestOrigin) },
    )
  }

  const signature = createHmac('sha256', signatureSecret)
    .update(`${token}:${requestOrigin}`)
    .digest('hex')

  try {
    const upstream = await fetch(`${BACKEND_BASE}/api/v1/public/embed/${encodeURIComponent(token)}/session`, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'x-radioso-embed-origin': requestOrigin,
        'x-radioso-embed-signature': signature,
      },
    })

    const contentType = upstream.headers.get('content-type') ?? 'application/json'

    return new Response(upstream.body, {
      status: upstream.status,
      headers: withCorsHeaders(requestOrigin, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
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
      { status: 503, headers: withCorsHeaders(requestOrigin) },
    )
  }
}
