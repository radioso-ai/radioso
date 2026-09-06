import { describe, expect, it } from 'vitest'

import nextConfig from '../../next.config.mjs'

const getHeaderRoutes = async () => {
  if (!nextConfig.headers) {
    throw new Error('Next.js headers configuration is missing')
  }
  return nextConfig.headers()
}

const getRewriteRoutes = async () => {
  if (!nextConfig.rewrites) {
    throw new Error('Next.js rewrites configuration is missing')
  }
  return nextConfig.rewrites()
}

describe('next security headers', () => {
  it('sets a global content security policy and browser hardening headers', async () => {
    expect(nextConfig.headers).toBeTypeOf('function')

    const routes = await getHeaderRoutes()
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

  it('allows the public embed document to be framed by host sites', async () => {
    expect(nextConfig.headers).toBeTypeOf('function')

    const routes = await getHeaderRoutes()
    const embedHeaders = routes.find((route) => route.source === '/embed/:path*')?.headers ?? []
    const embedFrameHeaders = routes.find((route) => route.source === '/embed-frame')?.headers ?? []
    const headerValues = new Map(embedHeaders.map((header) => [header.key, header.value]))
    const frameHeaderValues = new Map(embedFrameHeaders.map((header) => [header.key, header.value]))

    expect(routes.findIndex((route) => route.source === '/embed/:path*')).toBeGreaterThan(
      routes.findIndex((route) => route.source === '/:path*'),
    )
    expect(routes.findIndex((route) => route.source === '/embed-frame')).toBeGreaterThan(
      routes.findIndex((route) => route.source === '/:path*'),
    )
    expect(headerValues.get('Content-Security-Policy')).toContain("default-src 'self'")
    expect(headerValues.get('Content-Security-Policy')).toContain("object-src 'none'")
    expect(headerValues.get('Content-Security-Policy')).not.toContain('frame-ancestors')
    expect(headerValues.get('X-Content-Type-Options')).toBe('nosniff')
    expect(headerValues.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    expect(headerValues.get('Permissions-Policy')).toContain('camera=()')
    expect(frameHeaderValues.get('Content-Security-Policy')).toContain("default-src 'self'")
    expect(frameHeaderValues.get('Content-Security-Policy')).toContain("object-src 'none'")
    expect(frameHeaderValues.get('Content-Security-Policy')).not.toContain('frame-ancestors')
    expect(frameHeaderValues.get('X-Content-Type-Options')).toBe('nosniff')
    expect(frameHeaderValues.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    expect(frameHeaderValues.get('Permissions-Policy')).toContain('camera=()')
  })

  it('hardens the operator MCP consent screen against framing, referrers, and caching', async () => {
    const routes = await getHeaderRoutes()
    const consentHeaders = routes.find((route) => route.source === '/oauth/operator-mcp/consent')?.headers ?? []
    const values = new Map(consentHeaders.map((header) => [header.key, header.value]))
    expect(values.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
    expect(values.get('Referrer-Policy')).toBe('no-referrer')
    expect(values.get('Cache-Control')).toBe('no-store')
    expect(values.get('X-Frame-Options')).toBe('DENY')
  })

  it('proxies the legacy widget hostname to the primary EU frontend', async () => {
    const routes = await getRewriteRoutes()

    expect(routes).toContainEqual({
      source: '/:path*',
      has: [{ type: 'host', value: 'platform.radioso.dev' }],
      destination: 'https://app.radioso.ai/:path*',
    })
  })

  it('proxies public operator MCP OAuth issuer paths to the backend API', async () => {
    const routes = await getRewriteRoutes()

    expect(routes).toContainEqual({
      source: '/.well-known/oauth-authorization-server',
      destination: '/backend/.well-known/oauth-authorization-server',
    })
    expect(routes).toContainEqual({
      source: '/api/v1/operator-mcp/oauth/:path*',
      destination: '/backend/api/v1/operator-mcp/oauth/:path*',
    })
  })
})
