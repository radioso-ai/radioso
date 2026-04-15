import { createHmac } from 'node:crypto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BACKEND_BASE = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:8080'

const resolveOrigin = (value: unknown) => {
  if (typeof value !== 'string') {
    return null
  }

  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params
  const signatureSecret = process.env.SESSION_COOKIE_SECRET

  if (!signatureSecret) {
    return Response.json(
      {
        error: {
          code: 'embed_unavailable',
          message: 'This embedded chat launch could not be verified.',
        },
      },
      { status: 503 },
    )
  }

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return Response.json(
      {
        error: {
          code: 'bad_request',
          message: 'Invalid embed session request',
        },
      },
      { status: 400 },
    )
  }

  const origin =
    payload && typeof payload === 'object' && 'origin' in payload
      ? resolveOrigin(payload.origin)
      : null

  if (!origin) {
    return Response.json(
      {
        error: {
          code: 'bad_request',
          message: 'Invalid embed session request',
        },
      },
      { status: 400 },
    )
  }

  const signature = createHmac('sha256', signatureSecret)
    .update(`${token}:${origin}`)
    .digest('hex')

  try {
    const upstream = await fetch(`${BACKEND_BASE}/api/v1/public/embed/${encodeURIComponent(token)}/session`, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'x-radioso-embed-origin': origin,
        'x-radioso-embed-signature': signature,
      },
    })

    const contentType = upstream.headers.get('content-type') ?? 'application/json'

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
      },
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
      { status: 503 },
    )
  }
}
