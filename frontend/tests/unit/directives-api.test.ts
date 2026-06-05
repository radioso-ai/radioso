import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { directivesApi } from '@/lib/api'

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
  ok: true,
  status,
  headers: {
    get: () => 'application/json',
  },
  json: async () => payload,
})

describe('directivesApi', () => {
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

  it('lists agent directives with workspace bearer auth', async () => {
    const listResponse = {
      directives: [],
      builtIns: [{
        name: 'concise-readable-formatting',
        condition: { kind: 'always' },
        action: 'Prefer short paragraphs and answer directly.',
        priority: 60,
        criticality: 'medium',
        description: 'Default readable answer formatting for public assistant replies.',
      }],
    }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(listResponse))
    vi.stubGlobal('fetch', fetchMock)

    await expect(directivesApi.listDirectives('agent-1')).resolves.toEqual(listResponse)

    expect(fetchMock).toHaveBeenCalledWith(
      '/backend/api/v1/agents/agent-1/directives',
      expect.objectContaining({
        method: 'GET',
        credentials: 'omit',
      }),
    )
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe('Bearer radioso_cached_token')
  })

  it('creates agent directives with the request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      directive: { id: 'directive-1' },
      coherence: { coherent: true, conflicts: [], rationale: 'ok' },
    }, 201))
    vi.stubGlobal('fetch', fetchMock)

    await directivesApi.createDirective('agent-1', {
      name: 'handoff-tone',
      condition: { kind: 'always' },
      action: 'Be specific.',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/backend/api/v1/agents/agent-1/directives',
      expect.objectContaining({
        method: 'POST',
        credentials: 'omit',
        body: JSON.stringify({
          name: 'handoff-tone',
          condition: { kind: 'always' },
          action: 'Be specific.',
        }),
      }),
    )
  })

  it('includes directive replacement relationships when creating agent directives', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      directive: { id: 'directive-1' },
      coherence: { coherent: true, conflicts: [], rationale: 'ok' },
    }, 201))
    vi.stubGlobal('fetch', fetchMock)

    await directivesApi.createDirective('agent-1', {
      name: 'Override: inline-supported-links',
      condition: { kind: 'always' },
      action: 'Use footnote-style source links.',
      excludes: ['inline-supported-links'],
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/backend/api/v1/agents/agent-1/directives',
      expect.objectContaining({
        method: 'POST',
        credentials: 'omit',
        body: JSON.stringify({
          name: 'Override: inline-supported-links',
          condition: { kind: 'always' },
          action: 'Use footnote-style source links.',
          excludes: ['inline-supported-links'],
        }),
      }),
    )
  })

  it('updates agent directives with PATCH', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      directive: { id: 'directive-1' },
      coherence: { coherent: true, conflicts: [], rationale: 'ok' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await directivesApi.updateDirective('agent-1', 'directive-1', {
      action: 'Use the account tier when escalating.',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/backend/api/v1/agents/agent-1/directives/directive-1',
      expect.objectContaining({
        method: 'PATCH',
        credentials: 'omit',
        body: JSON.stringify({
          action: 'Use the account tier when escalating.',
        }),
      }),
    )
  })

  it('deletes agent directives and accepts 204 responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      headers: {
        get: () => null,
      },
    })
    vi.stubGlobal('fetch', fetchMock)

    await directivesApi.deleteDirective('agent-1', 'directive-1')

    expect(fetchMock).toHaveBeenCalledWith(
      '/backend/api/v1/agents/agent-1/directives/directive-1',
      expect.objectContaining({
        method: 'DELETE',
        credentials: 'omit',
      }),
    )
  })
})
