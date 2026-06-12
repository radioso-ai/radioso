import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { routinesApi } from '@/lib/api'

const createLocalStorage = (seed: Record<string, string> = {}) => {
  const store = new Map(Object.entries(seed))
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
  }
}

const jsonResponse = (payload: unknown, status = 200) => ({
  ok: status < 400,
  status,
  headers: {
    get: () => 'application/json',
  },
  json: async () => payload,
})

const routineDraft = {
  name: 'Collect intake',
  activation: { triggerDescription: 'Visitor asks for pricing', priority: 10 },
  slots: [{
    stableSlotId: 'slot_email',
    key: 'email',
    type: 'email' as const,
    required: true,
    description: 'Visitor email',
    ordinal: 0,
  }],
  steps: [{
    stableStepId: 'ask_email',
    kind: 'chat' as const,
    instruction: 'Ask for {{slot.email}}.',
    toolRef: null,
    ordinal: 0,
    metadata: {},
  }],
  transitions: [{
    fromStep: 'ask_email',
    toRef: 'complete',
    guardKind: 'default' as const,
    guardText: null,
    outcomeStatus: null,
    counterLimit: null,
    ordinal: 0,
  }],
  terminals: [{
    stableStepId: 'complete',
    kind: 'complete' as const,
    instruction: null,
    ordinal: 0,
  }],
}

describe('routinesApi', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      localStorage: createLocalStorage({
        'radioso.activeWorkspaceId': 'workspace-1',
        'radioso.workspaceTokens': JSON.stringify({ 'workspace-1': 'radioso_cached_token' }),
      }),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists routines with workspace bearer auth', async () => {
    const listResponse = { routines: [] }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(listResponse))
    vi.stubGlobal('fetch', fetchMock)

    await expect(routinesApi.listRoutines('agent-1')).resolves.toEqual(listResponse)

    expect(fetchMock).toHaveBeenCalledWith(
      '/backend/api/v1/agents/agent-1/routines',
      expect.objectContaining({ method: 'GET', credentials: 'omit' }),
    )
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe('Bearer radioso_cached_token')
  })

  it('creates and updates routine drafts with request bodies', async () => {
    const saveResponse = {
      routine: {
        id: 'routine-1',
        lineageId: 'lineage-1',
        agentId: 'agent-1',
        version: 1,
        status: 'draft' as const,
        createdAt: '2026-06-12T00:00:00.000Z',
        updatedAt: '2026-06-12T00:00:00.000Z',
        ...routineDraft,
      },
      validation: { ok: true, diagnostics: [] },
    }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(saveResponse, 201))
    vi.stubGlobal('fetch', fetchMock)

    await routinesApi.createRoutine('agent-1', routineDraft)
    await routinesApi.updateRoutine('agent-1', 'routine-1', routineDraft)

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/backend/api/v1/agents/agent-1/routines',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(routineDraft) }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/backend/api/v1/agents/agent-1/routines/routine-1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify(routineDraft) }),
    )
  })

  it('requests a routine draft assist proposal with workspace bearer auth', async () => {
    const assistResponse = { draft: routineDraft, validation: { ok: true, diagnostics: [] } }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(assistResponse))
    vi.stubGlobal('fetch', fetchMock)

    await expect(routinesApi.draftRoutineFromProcedure('agent-1', {
      prose: 'Collect the visitor email and confirm.',
    })).resolves.toEqual(assistResponse)

    expect(fetchMock).toHaveBeenCalledWith(
      '/backend/api/v1/agents/agent-1/routines/draft-assist',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ prose: 'Collect the visitor email and confirm.' }),
        credentials: 'omit',
      }),
    )
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe('Bearer radioso_cached_token')
  })

  it('validates, publishes, and preserves publish rejection diagnostics', async () => {
    const validation = {
      ok: false,
      diagnostics: [{
        code: 'missing_terminal' as const,
        location: 'routine:Collect intake',
        message: 'missing terminal',
      }],
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ validation }))
      .mockResolvedValueOnce(jsonResponse({ error: 'Routine definition is invalid', validation }, 422))
    vi.stubGlobal('fetch', fetchMock)

    await expect(routinesApi.validateRoutine('agent-1', 'routine-1')).resolves.toEqual({ validation })
    await expect(routinesApi.publishRoutine('agent-1', 'routine-1')).rejects.toMatchObject({
      response: { validation },
    })
  })

  it('requests revise, archive, and restore lifecycle transitions', async () => {
    const routine = {
      id: 'routine-2',
      lineageId: 'lineage-1',
      agentId: 'agent-1',
      version: 2,
      status: 'draft' as const,
      createdAt: '2026-06-12T00:00:00.000Z',
      updatedAt: '2026-06-12T00:00:00.000Z',
      ...routineDraft,
    }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ routine }))
    vi.stubGlobal('fetch', fetchMock)

    await routinesApi.reviseRoutine('agent-1', 'routine-1')
    await routinesApi.archiveRoutine('agent-1', 'routine-1')
    await routinesApi.restoreRoutine('agent-1', 'routine-1')

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/backend/api/v1/agents/agent-1/routines/routine-1/revise',
      expect.objectContaining({ method: 'POST', credentials: 'omit' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/backend/api/v1/agents/agent-1/routines/routine-1/archive',
      expect.objectContaining({ method: 'POST', credentials: 'omit' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/backend/api/v1/agents/agent-1/routines/routine-1/restore',
      expect.objectContaining({ method: 'POST', credentials: 'omit' }),
    )
  })

  it('deletes routine drafts and accepts 204 responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      headers: { get: () => null },
    })
    vi.stubGlobal('fetch', fetchMock)

    await routinesApi.deleteRoutine('agent-1', 'routine-1')

    expect(fetchMock).toHaveBeenCalledWith(
      '/backend/api/v1/agents/agent-1/routines/routine-1',
      expect.objectContaining({ method: 'DELETE', credentials: 'omit' }),
    )
  })
})
