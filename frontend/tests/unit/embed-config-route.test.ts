import { afterEach, describe, expect, it, vi } from 'vitest'

import { createEmbedConfigCache } from '@/lib/server/embed-config-cache'

const CONFIG = { launcherLabel: 'Chat with us', launcherPosition: 'bottom-right' }

const configResponse = () =>
  new Response(JSON.stringify(CONFIG), { status: 200, headers: { 'Content-Type': 'application/json' } })

const hostPageRequest = (origin: string | null, token = 'embed-token') =>
  new Request(`https://app.example.com/api/embed/config/${token}`, {
    headers: origin ? { Origin: origin } : {},
  })

const loadRoute = async () => {
  const { GET } = await import('@/app/api/embed/config/[token]/route')
  return (request: Request, token = 'embed-token') => GET(request, { params: Promise.resolve({ token }) })
}

describe('embed config route', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('answers repeated page views of one site from a single backend read', async () => {
    const fetchMock = vi.fn(async () => configResponse())
    vi.stubGlobal('fetch', fetchMock)
    const get = await loadRoute()

    const first = await get(hostPageRequest('https://shop.example.com'))
    const second = await get(hostPageRequest('https://shop.example.com'))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    for (const response of [first, second]) {
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(CONFIG)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://shop.example.com')
      expect(response.headers.get('Vary')).toBe('Origin')
    }
    expect(first.headers.get('Cache-Control')).toBe('public, max-age=60, s-maxage=300')
  })

  it('keeps a held answer out of a CDN, so a change the backend invalidated there never comes back', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => configResponse()))
    const get = await loadRoute()

    await get(hostPageRequest('https://shop.example.com'))
    const held = await get(hostPageRequest('https://shop.example.com'))

    expect(held.headers.get('Cache-Control')).toBe('private, max-age=60')
  })

  it('asks the backend again for another site, since the backend admits each origin itself', async () => {
    const fetchMock = vi.fn(async () => configResponse())
    vi.stubGlobal('fetch', fetchMock)
    const get = await loadRoute()

    await get(hostPageRequest('https://shop.example.com'))
    const other = await get(hostPageRequest('https://blog.example.com'))

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(other.headers.get('Access-Control-Allow-Origin')).toBe('https://blog.example.com')
  })

  it('never keeps a refusal, so a site the backend rejected is asked about again', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'This website is not approved' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)
    const get = await loadRoute()

    const first = await get(hostPageRequest('https://unknown.example.com'))
    await get(hostPageRequest('https://unknown.example.com'))

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(first.status).toBe(400)
    expect(first.headers.get('Cache-Control')).toBe('no-store')
    expect(first.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('picks up operator changes once the held answer is half a minute old', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-16T10:00:00Z'))
    const fetchMock = vi.fn(async () => configResponse())
    vi.stubGlobal('fetch', fetchMock)
    const get = await loadRoute()

    await get(hostPageRequest('https://shop.example.com'))
    vi.setSystemTime(new Date('2026-11-16T10:00:29Z'))
    await get(hostPageRequest('https://shop.example.com'))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date('2026-11-16T10:00:31Z'))
    await get(hostPageRequest('https://shop.example.com'))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('embed config cache', () => {
  it('drops the oldest answer when full, so random tokens cannot grow it without bound', () => {
    const cache = createEmbedConfigCache({ ttlMs: 30_000, maxEntries: 2, now: () => 0 })
    const config = { body: '{}', contentType: 'application/json' }

    cache.set('token-a', null, config)
    cache.set('token-b', 'https://shop.example.com', config)
    cache.set('token-c', 'https://shop.example.com', config)

    expect(cache.get('token-a', null)).toBeNull()
    expect(cache.get('token-b', 'https://shop.example.com')).toEqual(config)
    expect(cache.get('token-c', 'https://shop.example.com')).toEqual(config)
  })
})
