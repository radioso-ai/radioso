import { afterEach, describe, expect, it, vi } from 'vitest'

import { copyDashboardLink } from '@/lib/copy-dashboard-link'

describe('copyDashboardLink', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('copies the absolute link', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('window', { location: { href: 'https://app.example.com/w/support/agents/a1?view=history' } })
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    await expect(copyDashboardLink('/w/support/agents/a1?testExecution=t1')).resolves.toEqual({
      copied: true,
      url: 'https://app.example.com/w/support/agents/a1?testExecution=t1',
    })
    expect(writeText).toHaveBeenCalledWith('https://app.example.com/w/support/agents/a1?testExecution=t1')
  })

  it('returns the link to show when the page has no clipboard access, as on a plain-HTTP host', async () => {
    vi.stubGlobal('window', { location: { href: 'http://intranet-host/w/support/agents/a1' } })
    vi.stubGlobal('navigator', {})

    await expect(copyDashboardLink('/w/support/agents/a1?testExecution=t1')).resolves.toEqual({
      copied: false,
      url: 'http://intranet-host/w/support/agents/a1?testExecution=t1',
    })
  })
})
