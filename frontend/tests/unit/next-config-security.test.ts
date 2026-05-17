import { describe, expect, it } from 'vitest'

import nextConfig from '../../next.config.mjs'

describe('next security headers', () => {
  it('sets a global content security policy and browser hardening headers', async () => {
    expect(nextConfig.headers).toBeTypeOf('function')

    const routes = await nextConfig.headers()
    const globalHeaders = routes.find((route) => route.source === '/:path*')?.headers ?? []
    const headerValues = new Map(globalHeaders.map((header) => [header.key, header.value]))

    expect(headerValues.get('Content-Security-Policy')).toContain("default-src 'self'")
    expect(headerValues.get('Content-Security-Policy')).toContain("object-src 'none'")
    expect(headerValues.get('Content-Security-Policy')).toContain("base-uri 'self'")
    expect(headerValues.get('Content-Security-Policy')).toContain("frame-ancestors 'self'")
    expect(headerValues.get('Content-Security-Policy')).toContain("script-src-attr 'none'")
    expect(headerValues.get('X-Content-Type-Options')).toBe('nosniff')
    expect(headerValues.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    expect(headerValues.get('Permissions-Policy')).toContain('camera=()')
  })
})
