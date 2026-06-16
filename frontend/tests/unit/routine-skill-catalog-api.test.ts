import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { parseSkillAuthoringCatalogResponse, routineSkillCatalogApi } from '@/lib/api-routine-skill-catalog'

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

describe('routineSkillCatalogApi', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      localStorage: createLocalStorage({
        'radioso.activeWorkspaceId': 'workspace-1',
        'radioso.workspaceTokens': JSON.stringify({ 'workspace-1': 'workspace-token' }),
      }),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('parses typed inputs and outcomes from the catalog response', () => {
    const skills = parseSkillAuthoringCatalogResponse({
      skills: [{
        skillName: 'send_email',
        displayName: 'Send email',
        description: 'Drafts a customer reply.',
        inputs: [
          { key: 'recipient', type: 'email', required: true, description: 'Customer address' },
          { key: 'tone', type: 'enum', required: false, enumValues: ['formal', 'friendly'] },
        ],
        outcomes: [{ name: 'sent', displayName: 'Sent', status: 'sent', description: 'Message accepted by provider' }],
        hasDataOutputs: false,
      }],
    })

    expect(skills).toEqual([{
      skillName: 'send_email',
      displayName: 'Send email',
      description: 'Drafts a customer reply.',
      inputs: [
        { key: 'recipient', type: 'email', required: true, description: 'Customer address' },
        { key: 'tone', type: 'enum', required: false, enumValues: ['formal', 'friendly'] },
      ],
      outcomes: [{ name: 'sent', displayName: 'Sent', status: 'sent', description: 'Message accepted by provider' }],
      hasDataOutputs: false,
    }])
  })

  it('rejects malformed catalog descriptors', () => {
    expect(() => parseSkillAuthoringCatalogResponse({
      skills: [{
        skillName: 'send_email',
        displayName: 'Send email',
        inputs: [{ key: 'recipient', type: 'file', required: true }],
        outcomes: [],
        hasDataOutputs: true,
      }],
    })).toThrow(/unsupported type/u)
  })

  it('requests the per-agent catalog with workspace bearer auth', async () => {
    const payload = { skills: [] }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload))
    vi.stubGlobal('fetch', fetchMock)

    await expect(routineSkillCatalogApi.listRoutineSkillCatalog('agent-1')).resolves.toEqual([])

    expect(fetchMock).toHaveBeenCalledWith(
      '/backend/api/v1/agents/agent-1/routine-skill-catalog',
      expect.objectContaining({ method: 'GET', credentials: 'omit' }),
    )
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe('Bearer workspace-token')
  })
})
