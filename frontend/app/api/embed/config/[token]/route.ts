export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BACKEND_BASE =
  process.env.RADIOSO_API_INTERNAL_URL ??
  process.env.BACKEND_INTERNAL_URL ??
  'http://localhost:8080'

// Public, non-credentialed embed config. Wildcard origin (no per-site variance)
// and no Accept-Language dependency, so a CDN can cache a single object per
// token. The origin allowlist is still enforced at session creation.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'OPTIONS, GET',
  'Access-Control-Allow-Headers': 'Content-Type',
}

// Short browser TTL, longer shared/edge TTL, serve-stale while revalidating.
const CDN_CACHE_CONTROL = 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400'

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params

  try {
    const upstream = await fetch(`${BACKEND_BASE}/api/v1/public/chat/${encodeURIComponent(token)}/embed-config`, {
      method: 'GET',
      cache: 'no-store',
      headers: {
        'X-Forwarded-Prefix': '/backend',
      },
    })
    const contentType = upstream.headers.get('content-type') ?? 'application/json'

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': contentType,
        'Cache-Control': upstream.ok ? CDN_CACHE_CONTROL : 'no-store',
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
      { status: 503, headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' } },
    )
  }
}
