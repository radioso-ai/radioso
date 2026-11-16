/* @vitest-environment jsdom */

import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  listAgents: vi.fn(),
  getGeneralSettings: vi.fn(),
  listCredentials: vi.fn(),
  getInstallStatus: vi.fn(),
  listBindings: vi.fn(),
  getConnector: vi.fn(),
  getEmailOverview: vi.fn(),
  getRevisionState: vi.fn(),
}))
vi.mock('@/lib/api', () => ({ agentsApi: { listAgents: api.listAgents, getGeneralSettings: api.getGeneralSettings } }))
vi.mock('@/lib/api-agent-channel-credentials', () => ({ agentChannelCredentialsApi: { list: api.listCredentials } }))
vi.mock('@/lib/api-slack', () => ({ slackApi: { getInstallStatus: api.getInstallStatus, listBindings: api.listBindings } }))
vi.mock('@/lib/api-connectors', () => ({ connectorsApi: { get: api.getConnector } }))
vi.mock('@/lib/api-email-channel', () => ({ emailChannelApi: { getOverview: api.getEmailOverview } }))
vi.mock('@/lib/api-agent-revisions', () => ({ agentRevisionsApi: { getState: api.getRevisionState } }))

import { AgentAreaPorts } from '@/components/dashboard/agent-area-providers'
import { useAgentChannels, type AgentChannelsPort } from '@/lib/agent-channels-context'
import { useAgentRevision, type AgentRevisionPort } from '@/lib/agent-revision-context'
import type { AgentSettings } from '@/lib/api'
import type { AgentRevisionState } from '@/lib/api-agent-revisions'

const agent = (id: string, name: string, isDefault = false) => ({ id, name, internalName: '', isDefault }) as AgentSettings
const marta = agent('11111111-1111-4111-8111-111111111111', 'Marta', true)
const sales = agent('22222222-2222-4222-8222-222222222222', 'Sales')

const revisionState = (agentId: string, status: AgentRevisionState['status']): AgentRevisionState => ({
  agentId, status, draft: { generation: 1, basePublishedRevisionId: null, updatedAt: '2026-01-01T00:00:00.000Z' }, publishedRevision: null, canPublish: true,
})

let channelReaders: AgentChannelsPort[] = []
let revisionReaders: AgentRevisionPort[] = []
function Readers() {
  const first = useAgentChannels()
  const second = useAgentChannels()
  const revision = useAgentRevision()
  const secondRevision = useAgentRevision()
  useEffect(() => { channelReaders = [first, second]; revisionReaders = [revision, secondRevision] })
  return null
}

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const quiet = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)) })
// Polls in short acts, so React can flush what each step set in motion.
const until = async (check: () => void) => {
  const deadline = Date.now() + 3000
  for (;;) {
    try {
      check()
      return
    } catch (failure) {
      if (Date.now() > deadline) throw failure
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    }
  }
}

describe('the agent area ports', () => {
  let container: HTMLDivElement
  let root: Root

  const mount = async (routeAgentId: string) => {
    await act(async () => {
      root.render(<AgentAreaPorts workspaceId="workspace-1" routeAgentId={routeAgentId} enabled><Readers /></AgentAreaPorts>)
    })
    await until(() => {
      expect(revisionReaders[0]?.state).not.toBeNull()
      expect(channelReaders[0]?.entries).not.toBeNull()
    })
    await quiet()
  }

  beforeEach(() => {
    window.localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    api.listAgents.mockResolvedValue({ agents: [marta, sales] })
    api.getGeneralSettings.mockResolvedValue({ anonymousChatEnabled: false, websiteEmbedEnabled: false })
    api.listCredentials.mockResolvedValue({ credentials: [] })
    api.getInstallStatus.mockResolvedValue({ status: 'not_configured', readiness: { configured: true, missingEnvVars: [] } })
    api.listBindings.mockResolvedValue({ bindings: [] })
    api.getConnector.mockResolvedValue({ enabled: true, errorStatus: null })
    api.getEmailOverview.mockResolvedValue({ configured: false, mailboxes: [] })
    api.getRevisionState.mockImplementation(async (agentId: string) => revisionState(agentId, 'draft_dirty'))
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  it('reads the draft state once for every reader, and the channels once for every reader', async () => {
    await mount(marta.id)
    expect(api.getRevisionState).toHaveBeenCalledTimes(1)
    expect(api.getConnector).toHaveBeenCalledTimes(1)
    expect(api.listAgents).toHaveBeenCalledTimes(1)
    expect(revisionReaders[0].state?.status).toBe('draft_dirty')
    expect(revisionReaders[1].state).toBe(revisionReaders[0].state)
    expect(channelReaders[0].entries).not.toBeNull()
    expect(channelReaders[1].entries).toBe(channelReaders[0].entries)
  })

  it('never shows one agent the draft state or the channels that were read for another', async () => {
    let releaseSales: (state: AgentRevisionState) => void = () => undefined
    await mount(marta.id)
    expect(revisionReaders[0].state?.agentId).toBe(marta.id)
    api.getGeneralSettings.mockImplementation((agentId: string) => agentId === sales.id
      ? new Promise(() => undefined)
      : Promise.resolve({ anonymousChatEnabled: false, websiteEmbedEnabled: false }))
    api.getRevisionState.mockImplementation((agentId: string) => agentId === sales.id
      ? new Promise<AgentRevisionState>((resolve) => { releaseSales = resolve })
      : Promise.resolve(revisionState(agentId, 'draft_clean')))
    await act(async () => {
      root.render(<AgentAreaPorts workspaceId="workspace-1" routeAgentId={sales.id} enabled><Readers /></AgentAreaPorts>)
    })
    await until(() => expect(api.getRevisionState).toHaveBeenCalledWith(sales.id))
    // Sales' state and channels have not landed: Marta's are not shown in their place.
    expect(revisionReaders[0].state).toBeNull()
    expect(channelReaders[0].entries).toBeNull()
    await act(async () => { releaseSales(revisionState(sales.id, 'draft_clean')) })
    await until(() => expect(revisionReaders[0].state?.agentId).toBe(sales.id))
  })

  it('reads the channels again when a channel page asks, and not before', async () => {
    await mount(marta.id)
    expect(api.getConnector).toHaveBeenCalledTimes(1)
    expect(channelReaders[0].entries?.find((entry) => entry.id === 'web-chat')?.status).toBe('not-set-up')
    api.getGeneralSettings.mockResolvedValue({ anonymousChatEnabled: true, websiteEmbedEnabled: false })
    await act(async () => { channelReaders[0].refresh() })
    await until(() => expect(channelReaders[1].entries?.find((entry) => entry.id === 'web-chat')?.status).toBe('on'))
    expect(api.getConnector).toHaveBeenCalledTimes(2)
  })

  it('judges WhatsApp from the live agent list: only the default agent answers the number', async () => {
    await mount(sales.id)
    const whatsapp = channelReaders[0].entries?.find((entry) => entry.id === 'whatsapp-channel')
    expect(whatsapp).toMatchObject({ status: 'answered-elsewhere' })
    expect(channelReaders[0].whatsappAnsweringAgentName).toBe('Marta')
  })

  it('offers Slack only where the deployment has a Slack app', async () => {
    api.getInstallStatus.mockResolvedValue({ status: 'not_configured', readiness: { configured: false, missingEnvVars: ['SLACK_CLIENT_ID'] } })
    await mount(marta.id)
    expect(channelReaders[0].entries?.some((entry) => entry.id === 'slack-channel')).toBe(false)
  })
})
