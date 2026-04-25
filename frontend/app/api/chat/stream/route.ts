export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BACKEND_BASE = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:8080'

export async function POST(request: Request) {
  const workspaceId = request.headers.get('x-workspace-id')
  const cookie = request.headers.get('cookie')
  const authorization = request.headers.get('authorization')
  const body = await request.text()

  try {
    const upstream = await fetch(`${BACKEND_BASE}/api/v1/chat/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(workspaceId ? { 'X-Workspace-Id': workspaceId } : {}),
        ...(authorization ? { Authorization: authorization } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
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
  } catch (error) {
    const message =
      error instanceof Error
        ? `Chat backend is unavailable: ${error.message}`
        : 'Chat backend is unavailable.'

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
