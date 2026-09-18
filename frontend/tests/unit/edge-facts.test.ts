import { EDGE_FACTS_HEADERS, verifyEdgeFactsProof } from '@radioso/edge-proof'
import { afterEach, describe, expect, it, vi } from 'vitest'

const SECRET = 'a'.repeat(32)

describe('buildEdgeFactsHeaders', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('always sends the frontend marker, with no proof headers when no secret is configured', async () => {
    vi.stubEnv('RADIOSO_EDGE_PROOF_SECRET', '')
    const { buildEdgeFactsHeaders } = await import('@/lib/server/edge-facts')

    const request = new Request('https://embed.example.com/api/embed/session/token123', {
      headers: { 'x-forwarded-for': '203.0.113.9' },
    })

    const headers = buildEdgeFactsHeaders(request, { method: 'POST', path: '/api/v1/public/chat/token123/sessions' })

    expect(headers).toEqual({ [EDGE_FACTS_HEADERS.marker]: 'frontend' })
  })

  it('signs a verifiable proof when a secret is configured, and reports clientIp: null at hops=0', async () => {
    vi.stubEnv('RADIOSO_EDGE_PROOF_SECRET', SECRET)
    vi.stubEnv('RADIOSO_TRUSTED_PROXY_HOPS', '0')
    const { buildEdgeFactsHeaders } = await import('@/lib/server/edge-facts')

    const request = new Request('https://embed.example.com/api/public/chat/token123', {
      headers: {
        'x-forwarded-for': '203.0.113.9',
        'cf-ipcountry': 'nl',
        'user-agent': 'TestAgent/1.0',
        'accept-language': 'nl-NL,nl;q=0.9',
      },
    })

    const method = 'POST'
    const path = '/api/v1/public/chat/token123'
    const headers = buildEdgeFactsHeaders(request, { method, path })

    expect(headers[EDGE_FACTS_HEADERS.marker]).toBe('frontend')

    const verification = verifyEdgeFactsProof({
      headers,
      method,
      path,
      secret: SECRET,
    })

    expect(verification.ok).toBe(true)
    if (!verification.ok) return
    expect(verification.facts.clientIp).toBeNull()
    expect(verification.facts.geoHeaders).toEqual({ 'cf-ipcountry': 'nl' })
    expect(verification.facts.userAgent).toBe('TestAgent/1.0')
    expect(verification.facts.acceptLanguage).toBe('nl-NL,nl;q=0.9')
  })

  it('resolves clientIp from the trusted X-Forwarded-For suffix when hops > 0', async () => {
    vi.stubEnv('RADIOSO_EDGE_PROOF_SECRET', SECRET)
    vi.stubEnv('RADIOSO_TRUSTED_PROXY_HOPS', '1')
    const { buildEdgeFactsHeaders } = await import('@/lib/server/edge-facts')

    const request = new Request('https://embed.example.com/api/public/chat/token123', {
      headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.4' },
    })

    const method = 'POST'
    const path = '/api/v1/public/chat/token123'
    const headers = buildEdgeFactsHeaders(request, { method, path })

    const verification = verifyEdgeFactsProof({ headers, method, path, secret: SECRET })
    expect(verification.ok).toBe(true)
    if (!verification.ok) return
    expect(verification.facts.clientIp).toBe('10.0.0.4')
  })

  it('collects the operator geo-header override into the signed facts', async () => {
    vi.stubEnv('RADIOSO_EDGE_PROOF_SECRET', SECRET)
    vi.stubEnv('VISITOR_GEO_COUNTRY_HEADER', 'X-Geo-Country')
    const { buildEdgeFactsHeaders } = await import('@/lib/server/edge-facts')

    const request = new Request('https://embed.example.com/api/public/chat/token123', {
      headers: { 'x-geo-country': 'fr' },
    })

    const method = 'POST'
    const path = '/api/v1/public/chat/token123'
    const headers = buildEdgeFactsHeaders(request, { method, path })

    const verification = verifyEdgeFactsProof({ headers, method, path, secret: SECRET })
    expect(verification.ok).toBe(true)
    if (!verification.ok) return
    expect(verification.facts.geoHeaders).toEqual({ 'x-geo-country': 'fr' })
  })

  it('produces a proof that fails verification against a different upstream method or path', async () => {
    vi.stubEnv('RADIOSO_EDGE_PROOF_SECRET', SECRET)
    const { buildEdgeFactsHeaders } = await import('@/lib/server/edge-facts')

    const request = new Request('https://embed.example.com/api/public/chat/token123')
    const headers = buildEdgeFactsHeaders(request, { method: 'POST', path: '/api/v1/public/chat/token123' })

    const verification = verifyEdgeFactsProof({
      headers,
      method: 'POST',
      path: '/api/v1/public/chat/some-other-token',
      secret: SECRET,
    })
    expect(verification.ok).toBe(false)
  })
})
