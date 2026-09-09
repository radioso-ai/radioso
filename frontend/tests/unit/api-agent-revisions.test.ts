import { afterEach, describe, expect, it, vi } from 'vitest'

import { agentRevisionsApi } from '@/lib/api-agent-revisions'

const storage = () => ({
  getItem: (key: string) => key === 'radioso.activeWorkspaceId' ? 'workspace-1' : null,
  setItem: () => undefined,
  removeItem: () => undefined,
})

const jsonResponse = (payload: unknown) => ({
  ok: true,
  status: 200,
  headers: { get: () => 'application/json' },
  json: async () => payload,
})

describe('agentRevisionsApi', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('starts a fenced comparison with explicit immutable revision ids and test values', async () => {
    vi.stubGlobal('window', { localStorage: storage() })
    vi.stubGlobal('crypto', { randomUUID: () => 'test-execution-request-1' })
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      id: 'execution-1',
      generation: 3,
      mode: 'compare',
      sides: [],
    }))
    vi.stubGlobal('fetch', fetchMock)

    await agentRevisionsApi.startTest('agent-1', {
      mode: 'compare',
      revisionIds: ['published-7', 'candidate-8'],
      testValues: [{ contextVariableId: 'customer-tier', value: 'standard' }],
      expectedDraftGeneration: 8,
    })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/backend/api/v1/agents/agent-1/test-executions')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({
      mode: 'compare',
      revisionIds: ['published-7', 'candidate-8'],
      testValues: [{ contextVariableId: 'customer-tier', value: 'standard' }],
      expectedDraftGeneration: 8,
      idempotencyKey: 'test-execution-request-1',
    }))
  })

  it('publishes only the selected candidate with its concurrency tokens', async () => {
    vi.stubGlobal('window', { localStorage: storage() })
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ publication: {}, state: {} }))
    vi.stubGlobal('fetch', fetchMock)

    await agentRevisionsApi.publish('agent-1', 'candidate-8', {
      expectedDraftGeneration: 8,
      expectedPublishedRevisionId: 'published-7',
      idempotencyKey: 'publish-1',
    })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/backend/api/v1/agents/agent-1/revisions/candidate-8/publish')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({
      expectedDraftGeneration: 8,
      expectedPublishedRevisionId: 'published-7',
      idempotencyKey: 'publish-1',
    }))
  })

  it('retries one failed case for one immutable revision', async () => {
    vi.stubGlobal('window', { localStorage: storage() })
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'run-1', state: 'running', sides: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await agentRevisionsApi.retryEvalCase('run-1', 'candidate-8', 'case-3')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/backend/api/v1/evals/revision-runs/run-1/sides/candidate-8/cases/case-3/retry')
    expect(init.method).toBe('POST')
  })

  it('reads bounded private execution history through its agent-scoped port', async () => {
    vi.stubGlobal('window', { localStorage: storage() })
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ executions: [], nextCursor: null, hasMore: false }))
    vi.stubGlobal('fetch', fetchMock)

    await agentRevisionsApi.listTestExecutions('agent-1', { limit: 50, cursor: 'older' })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/backend/api/v1/agents/agent-1/test-executions?limit=50&cursor=older')
    expect(init.method).toBe('GET')
  })

  it('retains one settled comparison side through the private execution port', async () => {
    vi.stubGlobal('window', { localStorage: storage() })
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'retained-1', generation: 1, mode: 'single', sides: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await agentRevisionsApi.retainTestSide('agent-1', 'execution-1', 'side-2')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/backend/api/v1/agents/agent-1/test-executions/execution-1/sides/side-2/retain')
    expect(init.method).toBe('POST')
    expect(init.body).toBeUndefined()
  })
})
