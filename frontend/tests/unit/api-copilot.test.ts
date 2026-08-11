import { afterEach, describe, expect, it, vi } from 'vitest'

const requestMock = vi.fn()
const buildErrorMock = vi.fn()

vi.mock('@/lib/api-client', () => ({
  API_BASE: '/backend/api/v1',
  buildError: buildErrorMock,
  request: requestMock,
  getStoredActiveWorkspaceId: () => 'workspace-1',
}))

describe('copilotApi', () => {
  afterEach(() => {
    requestMock.mockReset()
    buildErrorMock.mockReset()
    vi.restoreAllMocks()
  })

  it('uses dashboard session authorization for all CRUD adapters', async () => {
    requestMock
      .mockResolvedValueOnce({ available: true, reason: 'ok' })
      .mockResolvedValueOnce({ conversations: [] })
      .mockResolvedValueOnce({ id: 'conversation-1', title: null, status: 'idle', createdAt: 'now', updatedAt: 'now', messages: [] })
      .mockResolvedValueOnce(undefined)

    const { copilotApi } = await import('@/lib/api-copilot')

    await copilotApi.getAvailability()
    await copilotApi.listConversations()
    await copilotApi.getConversation('conversation-1')
    await copilotApi.deleteConversation('conversation-1')

    expect(requestMock).toHaveBeenNthCalledWith(
      1,
      '/copilot/availability',
      { method: 'GET', signal: undefined },
      { withSession: true },
    )
    expect(requestMock).toHaveBeenNthCalledWith(
      2,
      '/copilot/conversations',
      { method: 'GET', signal: undefined },
      { withSession: true },
    )
    expect(requestMock).toHaveBeenNthCalledWith(
      3,
      '/copilot/conversations/conversation-1',
      { method: 'GET', signal: undefined },
      { withSession: true },
    )
    expect(requestMock).toHaveBeenNthCalledWith(
      4,
      '/copilot/conversations/conversation-1',
      { method: 'DELETE' },
      { withSession: true },
    )
  })

  it('posts the fixed turn body without a bearer token', async () => {
    const response = new Response(
      'event: conversation\ndata: {"conversationId":"conversation-1","turnId":"turn-1"}\n\n' +
      'event: outcome\ndata: {"status":"completed"}\n\n' +
      'event: done\ndata: {}\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    )
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))

    const { copilotApi } = await import('@/lib/api-copilot')
    await copilotApi.streamTurn({
      conversationId: null,
      message: 'Why did this answer refuse?',
      pageContext: { view: 'history', agentId: 'agent-1', conversationId: 'customer-1' },
    })

    expect(fetch).toHaveBeenCalledWith('/backend/api/v1/copilot/turns', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({
        conversationId: null,
        message: 'Why did this answer refuse?',
        pageContext: { view: 'history', agentId: 'agent-1', conversationId: 'customer-1' },
      }),
    }))
    const headers = (vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
    expect(headers['X-Workspace-Id']).toBe('workspace-1')
  })
})

describe('streamCopilotEvents', () => {
  it('parses the fixed event vocabulary and accumulates answer chunks', async () => {
    const activity = {
      toolCallId: 'tool-call-1',
      tool: 'Reading conversation trace',
      stage: 'started',
    } as const
    const response = new Response(
      'event: conversation\r\ndata: {"conversationId":"conversation-1","turnId":"turn-1"}\r\n\r\n' +
      `event: activity\r\ndata: ${JSON.stringify(activity)}\r\n\r\n` +
      'event: chunk\r\ndata: {"text":"The trace shows "}\r\n\r\n' +
      'event: chunk\r\ndata: {"text":"retrieval was skipped."}\r\n\r\n' +
      'event: outcome\r\ndata: {"status":"budget_exhausted"}\r\n\r\n' +
      'event: done\r\ndata: {}\r\n\r\n',
      { headers: { 'content-type': 'text/event-stream' } },
    )
    const events: string[] = []
    const { streamCopilotEvents } = await import('@/lib/api-copilot')

    const result = await streamCopilotEvents(response, {
      onConversation: () => events.push('conversation'),
      onActivity: (event) => events.push(`${event.tool}:${event.stage}`),
      onChunk: () => events.push('chunk'),
      onOutcome: (event) => events.push(event.status),
      onDone: () => events.push('done'),
    })

    expect(events).toEqual([
      'conversation',
      'Reading conversation trace:started',
      'chunk',
      'chunk',
      'budget_exhausted',
      'done',
    ])
    expect(result).toEqual({
      conversationId: 'conversation-1',
      turnId: 'turn-1',
      answer: 'The trace shows retrieval was skipped.',
      outcome: 'budget_exhausted',
    })
  })
})

describe('deriveCopilotPageContext', () => {
  it('derives the customer conversation id from parsed history selection state', async () => {
    const { deriveCopilotPageContext } = await import('@/lib/api-copilot')

    expect(deriveCopilotPageContext({
      section: 'activity',
      activityTab: 'all',
      historyItemKind: 'chat',
      historyItemId: 'customer-conversation-1',
      agentId: 'agent-1',
    })).toEqual({
      view: 'history',
      agentId: 'agent-1',
      conversationId: 'customer-conversation-1',
    })
  })

  it('maps dashboard sections to the contract enum without inspecting URL text', async () => {
    const { deriveCopilotPageContext } = await import('@/lib/api-copilot')

    expect(deriveCopilotPageContext({ section: 'knowledge', agentId: undefined })).toEqual({
      view: 'documents',
      agentId: null,
      conversationId: null,
    })
    expect(deriveCopilotPageContext({ section: 'agents', agentId: 'agent-1', agentTab: 'chat' })).toEqual({
      view: 'workbench',
      agentId: 'agent-1',
      conversationId: null,
    })
    expect(deriveCopilotPageContext({ section: 'settings', agentId: undefined })).toEqual({
      view: 'other',
      agentId: null,
      conversationId: null,
    })
    expect(deriveCopilotPageContext({ section: 'copilot', agentId: 'agent-1', agentTab: 'behavior' })).toEqual({
      view: 'agent',
      agentId: 'agent-1',
      conversationId: null,
    })
  })
})
