/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { useGreetingDraft, type GreetingDraft } from '@/components/dashboard/settings/use-greeting-draft'
import type { AgentGreetingDraft, ExactContentItem } from '@/lib/api-types'

const apiMocks = vi.hoisted(() => ({
  getDraft: vi.fn(),
  saveDraft: vi.fn(),
}))

vi.mock('@/lib/api-agent-greeting', () => ({ agentGreetingApi: apiMocks }))

const agentId = '22222222-2222-4222-8222-222222222222'

const stored: ExactContentItem = {
  chips: [],
  variants: [{ locale: 'en', body: 'Welcome back!', chipLabels: {} }],
}

describe('useGreetingDraft', () => {
  let container: HTMLDivElement
  let root: Root
  let latest: GreetingDraft

  beforeAll(() => {
    // React 19 reads this to decide whether act() may drive updates.
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  const Harness = ({ id, locale = 'en' }: { id: string; locale?: string }) => {
    latest = useGreetingDraft({ agentId: id, agentDefaultLocale: locale })
    return null
  }

  const render = async (id = agentId, locale?: string) => {
    await act(async () => root.render(<Harness id={id} locale={locale} />))
  }

  const loaded = async (greeting: AgentGreetingDraft) => {
    apiMocks.getDraft.mockResolvedValueOnce(greeting)
    await render()
  }

  beforeEach(() => {
    apiMocks.getDraft.mockReset()
    apiMocks.saveDraft.mockReset()
    apiMocks.saveDraft.mockImplementation(async (_id: string, greeting: AgentGreetingDraft) => ({ greeting, validation: { ok: true } }))
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('starts from the greeting the draft holds and reads clean', async () => {
    await loaded({ exactWordsEnabled: true, exactContent: stored })

    expect(apiMocks.getDraft).toHaveBeenCalledWith(agentId)
    expect(latest.loadState).toBe('ready')
    expect(latest.exactWordsEnabled).toBe(true)
    expect(latest.exactContent).toEqual(stored)
    expect(latest.dirty).toBe(false)
  })

  it('reports a failed load when the draft cannot be read', async () => {
    apiMocks.getDraft.mockRejectedValueOnce(new Error('network down'))
    await render()

    expect(latest.loadState).toBe('error')
    expect(latest.dirty).toBe(false)
  })

  it('never saves what it failed to load, so a blank editor cannot overwrite the stored draft', async () => {
    apiMocks.getDraft.mockRejectedValueOnce(new Error('network down'))
    await render()

    await act(async () => { await latest.save() })

    expect(apiMocks.saveDraft).not.toHaveBeenCalled()
  })

  it('loads again on request after a failed load', async () => {
    apiMocks.getDraft.mockRejectedValueOnce(new Error('network down'))
    await render()
    apiMocks.getDraft.mockResolvedValueOnce({ exactWordsEnabled: false, exactContent: stored })

    await act(async () => latest.reload())

    expect(latest.loadState).toBe('ready')
    expect(latest.exactContent).toEqual(stored)
  })

  it('goes dirty on an edit and clean again when the edit is put back', async () => {
    await loaded({ exactWordsEnabled: false, exactContent: null })

    act(() => latest.setExactWordsEnabled(true))
    expect(latest.dirty).toBe(true)

    act(() => latest.setExactWordsEnabled(false))
    expect(latest.dirty).toBe(false)
  })

  it('does not save a greeting that has not changed, so the draft generation is not bumped', async () => {
    await loaded({ exactWordsEnabled: true, exactContent: stored })

    await act(async () => { await latest.save() })

    expect(apiMocks.saveDraft).not.toHaveBeenCalled()
  })

  it('saves the edited greeting and reads clean afterwards', async () => {
    await loaded({ exactWordsEnabled: true, exactContent: stored })
    const edited: ExactContentItem = { chips: [], variants: [{ locale: 'en', body: 'Hello!', chipLabels: {} }] }

    act(() => latest.setExactContent(edited))
    expect(latest.dirty).toBe(true)
    await act(async () => { await latest.save() })

    expect(apiMocks.saveDraft).toHaveBeenCalledWith(agentId, { exactWordsEnabled: true, exactContent: edited })
    expect(latest.dirty).toBe(false)

    await act(async () => { await latest.save() })
    expect(apiMocks.saveDraft).toHaveBeenCalledTimes(1)
  })

  it('saves Exact words with nothing written as the blank default-language variant', async () => {
    await loaded({ exactWordsEnabled: false, exactContent: null })

    act(() => latest.setExactWordsEnabled(true))
    await act(async () => { await latest.save().catch(() => undefined) })

    expect(apiMocks.saveDraft).toHaveBeenCalledWith(agentId, {
      exactWordsEnabled: true,
      exactContent: { chips: [], variants: [{ locale: 'en', body: '', chipLabels: {} }] },
    })
  })

  it('keeps the edit, shows the server issues, and rethrows when the save is refused', async () => {
    await loaded({ exactWordsEnabled: false, exactContent: null })
    const issues = [{ path: 'variants[0].body', code: 'blank_body', message: 'Body must not be blank' }]
    const refusal = { status: 400, error: { code: 'bad_request', message: 'Exact greeting content is invalid', details: { issues } } }
    apiMocks.saveDraft.mockRejectedValueOnce(refusal)

    act(() => latest.setExactWordsEnabled(true))
    let thrown: unknown
    await act(async () => { thrown = await latest.save().catch((error: unknown) => error) })

    expect(thrown).toBe(refusal)
    expect(latest.issues).toEqual(issues)
    expect(latest.dirty).toBe(true)
  })

  it('treats a save the server accepted with issues as saved, and shows the issues', async () => {
    await loaded({ exactWordsEnabled: false, exactContent: null })
    const issues = [{ path: 'variants[0].body', code: 'blank_body', message: 'Body must not be blank' }]
    const blank: ExactContentItem = { chips: [], variants: [{ locale: 'en', body: '', chipLabels: {} }] }
    apiMocks.saveDraft.mockResolvedValueOnce({ greeting: { exactWordsEnabled: false, exactContent: blank }, validation: { ok: false, issues } })

    act(() => latest.setExactContent(blank))
    await act(async () => { await latest.save() })

    expect(latest.dirty).toBe(false)
    expect(latest.issues).toEqual(issues)
  })

  it('drops the shown issues as soon as the content is edited', async () => {
    await loaded({ exactWordsEnabled: false, exactContent: null })
    const issues = [{ path: 'variants[0].body', code: 'blank_body', message: 'Body must not be blank' }]
    apiMocks.saveDraft.mockRejectedValueOnce({ status: 400, error: { details: { issues } } })
    act(() => latest.setExactWordsEnabled(true))
    await act(async () => { await latest.save().catch(() => undefined) })
    expect(latest.issues).toEqual(issues)

    act(() => latest.setExactContent({ chips: [], variants: [{ locale: 'en', body: 'Hi', chipLabels: {} }] }))

    expect(latest.issues).toEqual([])
  })

  it('starts over from the other agent\'s draft when the agent changes', async () => {
    await loaded({ exactWordsEnabled: true, exactContent: stored })
    act(() => latest.setExactWordsEnabled(false))
    const otherAgentId = '33333333-3333-4333-8333-333333333333'
    apiMocks.getDraft.mockResolvedValueOnce({ exactWordsEnabled: false, exactContent: null })

    await render(otherAgentId)

    expect(apiMocks.getDraft).toHaveBeenLastCalledWith(otherAgentId)
    expect(latest.exactContent).toBeNull()
    expect(latest.dirty).toBe(false)
  })
})
