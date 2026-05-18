export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BACKEND_BASE =
  process.env.RADIOSO_API_INTERNAL_URL ??
  process.env.BACKEND_INTERNAL_URL ??
  'http://localhost:8080'
const CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'OPTIONS, GET',
  'Access-Control-Allow-Headers': 'Content-Type',
  Vary: 'Origin',
}

const withCorsHeaders = (
  origin: string | null,
  headers?: HeadersInit,
  options: { allowOrigin?: boolean } = {},
) => {
  const nextHeaders = new Headers(headers)
  Object.entries(CORS_HEADERS).forEach(([key, value]) => nextHeaders.set(key, value))
  const allowOrigin = options.allowOrigin ?? true
  if (origin && allowOrigin) {
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

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params
  const requestOrigin = resolveOrigin(request.headers.get('origin'))

  try {
    const upstream = await fetch(`${BACKEND_BASE}/api/v1/public/chat/${encodeURIComponent(token)}/embed-config`, {
      method: 'GET',
      cache: 'no-store',
      headers: {
        'X-Forwarded-Prefix': '/backend',
        ...(requestOrigin ? { Origin: requestOrigin } : {}),
      },
    })
    const contentType = upstream.headers.get('content-type') ?? 'application/json'

    return new Response(upstream.body, {
      status: upstream.status,
      headers: withCorsHeaders(
        requestOrigin,
        {
          'Content-Type': contentType,
          'Cache-Control': 'no-store',
        },
        { allowOrigin: upstream.ok },
      ),
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
      { status: 503, headers: withCorsHeaders(requestOrigin, undefined, { allowOrigin: false }) },
    )
  }
}
