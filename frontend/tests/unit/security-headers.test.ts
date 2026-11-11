import { describe, expect, it } from 'vitest'

import nextConfig from '../../next.config.mjs'

type HeaderRule = { source: string; headers: Array<{ key: string; value: string }> }

const scriptSrcFor = async (source: string): Promise<string> => {
  const rules = (await nextConfig.headers?.()) as HeaderRule[]
  const csp = rules.find((rule) => rule.source === source)?.headers.find((header) => header.key === 'Content-Security-Policy')?.value
  const scriptSrc = csp?.split('; ').find((directive) => directive.startsWith('script-src '))
  if (!scriptSrc) throw new Error(`no script-src for ${source}`)
  return scriptSrc
}

describe('content security policy', () => {
  it("lets the chat frame compile the voice client's WebAssembly resampler", async () => {
    expect(await scriptSrcFor('/embed-frame')).toContain("'wasm-unsafe-eval'")
    expect(await scriptSrcFor('/embed/:path*')).toContain("'wasm-unsafe-eval'")
  })

  it('keeps WebAssembly compilation out of the dashboard', async () => {
    expect(await scriptSrcFor('/:path*')).not.toContain('wasm-unsafe-eval')
  })
})

describe('permissions policy', () => {
  const permissionsFor = async (source: string): Promise<string | undefined> => {
    const rules = (await nextConfig.headers?.()) as HeaderRule[]
    return rules.find((rule) => rule.source === source)?.headers.find((header) => header.key === 'Permissions-Policy')?.value
  }

  // The policy is fixed when a document loads, and the dashboard is entered through `/`, `/login` or
  // an invitation and moved to `/w/...` on the client, so the page the operator lands on must allow it.
  it("lets every page of the app's own origin ask for the microphone, and no frame of another origin", async () => {
    for (const source of ['/:path*', '/embed/:path*', '/embed-frame']) {
      expect(await permissionsFor(source)).toBe('camera=(), microphone=(self), geolocation=()')
    }
  })
})
