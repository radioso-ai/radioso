import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

describe('canonical workspace dashboard realtime wiring', () => {
  it('derives the browser interest from the server-resolved realtime flag', async () => {
    const source = await readFile('app/w/[workspaceKey]/[[...segments]]/page.tsx', 'utf8')

    expect(source).toContain('realtimeEnabled')
    expect(source).toContain('WorkspaceEventsProvider')
    expect(source).toMatch(/WorkspaceEventsProvider[\s\S]{0,500}realtimeEnabled/)
  })
})
