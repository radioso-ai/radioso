import { describe, expect, it } from 'vitest'

import {
  buildConnectionInput,
  buildCreateConnectionInput,
  canSaveConnection,
  connectionDraftFrom,
  emptyConnectionDraft,
  emptyHeaderDraft,
} from '@/components/dashboard/settings/skills/api-connection-form-model'
import type { ApiConnection } from '@/lib/api-connections'

const stored: ApiConnection = {
  id: 'c1', name: 'shop-api', baseUrl: 'https://api.shop.example/v2', authScheme: 'bearer', authHeaderName: null,
  credentialMask: '****wxyz', defaultHeaders: { 'Accept-Language': 'en' }, createdAt: '', updatedAt: '',
}

describe('API connection form', () => {
  it('needs a credential for a new connection with auth, and a header name for the header scheme', () => {
    const draft = { ...emptyConnectionDraft(), name: 'a', baseUrl: 'https://a.example' }
    expect(canSaveConnection(draft, null)).toBe(true)
    expect(canSaveConnection({ ...draft, authScheme: 'bearer' }, null)).toBe(false)
    expect(canSaveConnection({ ...draft, authScheme: 'bearer', credential: 't' }, null)).toBe(true)
    expect(canSaveConnection({ ...draft, authScheme: 'header', credential: 't' }, null)).toBe(false)
    expect(canSaveConnection({ ...draft, authScheme: 'header', authHeaderName: 'X-Key', credential: 't' }, null)).toBe(true)
  })

  it('keeps the stored credential unless the scheme gained one', () => {
    const draft = connectionDraftFrom(stored)
    expect(draft.credential).toBe('')
    expect(canSaveConnection(draft, stored)).toBe(true)
    expect(canSaveConnection({ ...draft, authScheme: 'basic' }, { ...stored, authScheme: 'none', credentialMask: null })).toBe(false)
    expect(buildConnectionInput(draft)).not.toHaveProperty('credential')
    expect(buildConnectionInput({ ...draft, credential: 'new' })).toMatchObject({ credential: 'new' })
  })

  it('asks for the credential again when the origin, scheme or header name changes', () => {
    const draft = connectionDraftFrom(stored)
    expect(canSaveConnection({ ...draft, baseUrl: 'https://api.shop.example/v3' }, stored)).toBe(true)
    expect(canSaveConnection({ ...draft, baseUrl: 'https://other.example/v2' }, stored)).toBe(false)
    expect(canSaveConnection({ ...draft, baseUrl: 'https://other.example/v2', credential: 't' }, stored)).toBe(true)
    expect(canSaveConnection({ ...draft, authScheme: 'basic' }, stored)).toBe(false)
    const header = { ...stored, authScheme: 'header' as const, authHeaderName: 'X-Key' }
    expect(canSaveConnection(connectionDraftFrom(header), header)).toBe(true)
    expect(canSaveConnection({ ...connectionDraftFrom(header), authHeaderName: 'X-Other' }, header)).toBe(false)
  })

  it('sends the header name only for the header scheme and clears it otherwise', () => {
    const draft = { ...connectionDraftFrom(stored), authHeaderName: 'X-Key' }
    expect(buildConnectionInput(draft).authHeaderName).toBeNull()
    expect(buildConnectionInput({ ...draft, authScheme: 'header' }).authHeaderName).toBe('X-Key')
    expect(buildCreateConnectionInput(draft)).not.toHaveProperty('authHeaderName')
  })

  it('sends no credential for no auth and skips blank header rows', () => {
    const draft = {
      ...emptyConnectionDraft(), name: 'a', baseUrl: 'https://a.example', credential: 'left over',
      headers: [{ ...emptyHeaderDraft(), name: ' X-Tenant ', value: 't1' }, emptyHeaderDraft()],
    }
    const input = buildConnectionInput(draft)
    expect(input).not.toHaveProperty('credential')
    expect(input.defaultHeaders).toEqual({ 'X-Tenant': 't1' })
  })
})
