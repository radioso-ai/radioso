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
