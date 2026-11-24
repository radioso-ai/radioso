/* @vitest-environment jsdom */

import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ listCatalog: vi.fn() }))
vi.mock('@/lib/api-context-variables', () => ({ contextVariablesApi: api }))

import { DashboardQueryProvider } from '@/components/providers/dashboard-query-provider'
import { useInboxAttributeOptions, type InboxAttributeOptions } from '@/components/dashboard/inbox/use-inbox-attribute-options'
import type { ContextVariable } from '@/lib/api-types'

const choice = (name: string) => ({
  id: `${name}-id`,
  workspaceId: 'workspace-1',
  name,
  description: null,
  valueType: 'enum',
  options: [{ key: 'billing', label: 'Billing', description: null, archived: false }],
  trustTier: 'unverified',
  sensitivity: 'normal',
  defaultSurfacing: 'on_reference',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
}) as ContextVariable

const interest = {
  open: ({ onLifecycle }: { onLifecycle(signal: 'ready'): void }) => {
    onLifecycle('ready')
    return { close: vi.fn() }
  },
} as never

let options: InboxAttributeOptions
function Probe({ workspaceId }: { workspaceId: string }) {
  const value = useInboxAttributeOptions({ workspaceId, enabled: true })
  useEffect(() => { options = value })
  return null
}

/** Two readers of one workspace, as the Inbox filter and the Attributes block are. */
function Pair({ workspaceId }: { workspaceId: string }) {
  return <><Probe workspaceId={workspaceId} /><Probe workspaceId={workspaceId} /></>
}

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

describe('useInboxAttributeOptions', () => {
  let container: HTMLDivElement
  let root: Root
  const render = (workspaceId: string) => act(async () => { root.render(
    <DashboardQueryProvider key={workspaceId} workspaceId={workspaceId} interest={interest}><Probe workspaceId={workspaceId} /></DashboardQueryProvider>,
  ) })

  beforeEach(() => {
    api.listCatalog.mockReset()
    container = document.createElement('div')
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
  })

  it("offers a workspace's attributes, and none of them once another workspace is open", async () => {
    api.listCatalog.mockResolvedValueOnce({ contextVariables: [choice('topic')] })
    await render('workspace-1')
    await flush()
    expect(options.choices.map((entry) => entry.name)).toEqual(['topic'])

    api.listCatalog.mockReturnValueOnce(new Promise(() => {}))
    await render('workspace-2')
    expect(options.choices).toEqual([])
  })

  it('says the filter is unavailable when the read fails, but stays quiet when the operator may not read attributes', async () => {
    api.listCatalog.mockRejectedValueOnce(Object.assign(new Error('Server error'), { status: 500 }))
    await render('workspace-1')
    await flush()
    expect(options.unavailable).toBe(true)

    api.listCatalog.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }))
    await render('workspace-2')
    await flush()
    expect(options).toMatchObject({ choices: [], unavailable: false })
  })

  it('reads them again on reload, such as after the list refused a filter whose attribute changed', async () => {
    api.listCatalog.mockResolvedValueOnce({ contextVariables: [choice('topic')] })
    await render('workspace-1')
    await flush()

    api.listCatalog.mockResolvedValueOnce({ contextVariables: [choice('urgency')] })
    await act(async () => options.reload())
    await flush()

    expect(options.choices.map((entry) => entry.name)).toEqual(['urgency'])
  })

  it('reads the catalog once for every reader in the workspace', async () => {
    api.listCatalog.mockResolvedValue({ contextVariables: [choice('topic')] })
    await act(async () => {
      root.render(<DashboardQueryProvider workspaceId="workspace-1" interest={interest}><Pair workspaceId="workspace-1" /></DashboardQueryProvider>)
    })
    await flush()

    expect(api.listCatalog).toHaveBeenCalledTimes(1)
    expect(options.choices.map((entry) => entry.name)).toEqual(['topic'])
  })
})
