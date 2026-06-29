import { describe, expect, it } from 'vitest'

describe('favicon route', () => {
  it('redirects with a root-relative location so production does not inherit an internal localhost origin', async () => {
    const { GET } = await import('@/app/favicon.ico/route')

    const response = GET()

    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe('/radioso-icon.svg')
  })
})
