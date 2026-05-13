import type { components } from '../../../../../typescript-sdk/src/generated/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BACKEND_BASE = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:8080'

type AssistantChatRequest = components['schemas']['AssistantChatRequest']

type ChatStreamProxyRequestBody = Partial<AssistantChatRequest> & {
  query?: string
  bootstrapGreeting?: boolean
}

export async function POST(request: Request) {
  const workspaceId = request.headers.get('x-workspace-id')
  const cookie = request.headers.get('cookie')
  const authorization = request.headers.get('authorization')
  const rawBody = await request.text()
  const parsedBody = rawBody ? JSON.parse(rawBody) as ChatStreamProxyRequestBody : {}
  const body = JSON.stringify({
    agentId: parsedBody.agentId,
    conversationId: parsedBody.conversationId,
    message: parsedBody.message ?? parsedBody.query,
    startConversation: parsedBody.startConversation ?? parsedBody.bootstrapGreeting,
    stream: parsedBody.stream ?? true,
    userExpectedLocale: parsedBody.userExpectedLocale,
    inputMetadata: parsedBody.inputMetadata,
    sourceContext: parsedBody.sourceContext ?? {
      surface: 'authenticated_chat',
    },
  })

  try {
    const upstream = await fetch(`${BACKEND_BASE}/api/v1/assistant/chat`, {
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
