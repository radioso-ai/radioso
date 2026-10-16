import { describe, expect, it } from 'vitest'

import { GET } from '@/app/voice-worklets/[name]/route'

const get = (name: string, headers: Record<string, string> = {}) =>
  GET(new Request(`http://app.test/voice-worklets/${name}`, { headers }), { params: Promise.resolve({ name }) })

describe('voice worklets route', () => {
  it.each(['raw-audio-processor.js', 'audio-concat-processor.js'])('serves the client worklet %s from the installed package', async (name) => {
    const response = await get(name)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/javascript; charset=utf-8')
    expect(await response.text()).toContain('registerProcessor')
  })

  it('serves the resampler worklet', async () => {
    const response = await get('libsamplerate.js')

    expect(response.status).toBe(200)
    expect((await response.text()).length).toBeGreaterThan(0)
  })

  it('answers a browser holding the current file with 304', async () => {
    const first = await get('raw-audio-processor.js')
    const etag = first.headers.get('etag')
    expect(etag).toBeTruthy()
    expect(first.headers.get('cache-control')).toContain('no-cache')

    const again = await get('raw-audio-processor.js', { 'if-none-match': etag! })

    expect(again.status).toBe(304)
  })

  it.each(['scribe-audio-processor.js', '..%2Fpackage.json', 'constructor', '__proto__'])('serves nothing it does not name: %s', async (name) => {
    expect((await get(name)).status).toBe(404)
  })
})
