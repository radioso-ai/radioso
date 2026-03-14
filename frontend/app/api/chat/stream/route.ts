export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BACKEND_BASE = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:8080'

export async function POST(request: Request) {
  const authorization = request.headers.get('authorization')
  const body = await request.text()

  const upstream = await fetch(`${BACKEND_BASE}/api/v1/chat/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body,
    cache: 'no-store',
  })

  const contentType = upstream.headers.get('content-type') ?? 'application/json'

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  })
}
