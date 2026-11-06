/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { useGreetingDraft, type GreetingDraft } from '@/components/dashboard/settings/use-greeting-draft'
import { announceAgentGreetingChanged } from '@/lib/agent-draft-save-port'
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

  const Harness = ({ id, locale = 'en' }: { id: string | undefined; locale?: string }) => {
    latest = useGreetingDraft({ agentId: id, agentDefaultLocale: locale })
    return null
  }

  /** `null` renders the hook with no agent, as the page does while it is not showing the greeting. */
  const render = async (id: string | null = agentId, locale?: string) => {
    await act(async () => root.render(<Harness id={id ?? undefined} locale={locale} />))
  }

  const deferred = <T,>() => {
    let resolve: (value: T) => void = () => {}
    let reject: (reason: unknown) => void = () => {}
    const promise = new Promise<T>((resolveFn, rejectFn) => {
      resolve = resolveFn
      reject = rejectFn
    })
    return { promise, resolve, reject }
  }

  const announceGreetingChanged = async (id = agentId) => {
    await act(async () => { announceAgentGreetingChanged(id) })
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

  describe('wording typed and deleted again', () => {
    const typed: ExactContentItem = { chips: [], variants: [{ locale: 'en', body: 'W', chipLabels: {} }] }
    const deleted: ExactContentItem = { chips: [], variants: [{ locale: 'en', body: '', chipLabels: {} }] }

    it('is not a change once Exact words is switched back off, and nothing is written', async () => {
      await loaded({ exactWordsEnabled: false, exactContent: null })

      act(() => latest.setExactWordsEnabled(true))
      act(() => latest.setExactContent(typed))
      act(() => latest.setExactContent(deleted))
      act(() => latest.setExactWordsEnabled(false))

      expect(latest.dirty).toBe(false)
      await act(async () => { await latest.save() })
      expect(apiMocks.saveDraft).not.toHaveBeenCalled()
    })

    it('does not store a blank variant when the operator clears saved wording while Exact words is off', async () => {
      await loaded({ exactWordsEnabled: false, exactContent: stored })

      act(() => latest.setExactContent(deleted))
      expect(latest.dirty).toBe(true)
      await act(async () => { await latest.save() })

      expect(apiMocks.saveDraft).toHaveBeenCalledWith(agentId, { exactWordsEnabled: false, exactContent: null })
      expect(latest.dirty).toBe(false)
    })

    it('still saves wording written while Exact words is off', async () => {
      await loaded({ exactWordsEnabled: false, exactContent: null })

      act(() => latest.setExactContent(typed))
      expect(latest.dirty).toBe(true)
      await act(async () => { await latest.save() })

      expect(apiMocks.saveDraft).toHaveBeenCalledWith(agentId, { exactWordsEnabled: false, exactContent: typed })
    })
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
    const issues = [{ path: 'variants[0].body', code: 'unknown_reference', message: 'Unknown reference {{missing}}' }]
    const unknownReference: ExactContentItem = { chips: [], variants: [{ locale: 'en', body: 'Hi {{missing}}', chipLabels: {} }] }
    apiMocks.saveDraft.mockResolvedValueOnce({ greeting: { exactWordsEnabled: false, exactContent: unknownReference }, validation: { ok: false, issues } })

    act(() => latest.setExactContent(unknownReference))
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

  describe('while a save is in flight', () => {
    it('keeps what was typed meanwhile, and keeps it dirty once the save lands', async () => {
      await loaded({ exactWordsEnabled: true, exactContent: stored })
      const saving = deferred<{ greeting: AgentGreetingDraft; validation: { ok: true } }>()
      apiMocks.saveDraft.mockReturnValueOnce(saving.promise)
      const sent: ExactContentItem = { chips: [], variants: [{ locale: 'en', body: 'Hello!', chipLabels: {} }] }
      const typedMeanwhile: ExactContentItem = { chips: [], variants: [{ locale: 'en', body: 'Hello there!', chipLabels: {} }] }
      act(() => latest.setExactContent(sent))

      let pending: Promise<void> = Promise.resolve()
      act(() => { pending = latest.save() })
      act(() => latest.setExactContent(typedMeanwhile))
      await act(async () => {
        saving.resolve({ greeting: { exactWordsEnabled: true, exactContent: sent }, validation: { ok: true } })
        await pending
      })

      expect(latest.exactContent).toEqual(typedMeanwhile)
      expect(latest.dirty).toBe(true)
      await act(async () => { await latest.save() })
      expect(apiMocks.saveDraft).toHaveBeenLastCalledWith(agentId, { exactWordsEnabled: true, exactContent: typedMeanwhile })
      expect(latest.dirty).toBe(false)
    })

    it('shows the issues of what was sent only while the held wording is still what was sent', async () => {
      await loaded({ exactWordsEnabled: false, exactContent: null })
      const issues = [{ path: 'variants[0].body', code: 'blank_body', message: 'Body must not be blank' }]
      const blank: ExactContentItem = { chips: [], variants: [{ locale: 'en', body: '', chipLabels: {} }] }
      const saving = deferred<{ greeting: AgentGreetingDraft; validation: { ok: false; issues: typeof issues } }>()
      apiMocks.saveDraft.mockReturnValueOnce(saving.promise)
      act(() => latest.setExactContent(blank))

      let pending: Promise<void> = Promise.resolve()
      act(() => { pending = latest.save() })
      act(() => latest.setExactContent({ chips: [], variants: [{ locale: 'en', body: 'Now it has text', chipLabels: {} }] }))
      await act(async () => {
        saving.resolve({ greeting: { exactWordsEnabled: false, exactContent: blank }, validation: { ok: false, issues } })
        await pending
      })

      expect(latest.issues).toEqual([])
    })

    it('does not put the issues of a refused save on wording typed after it was sent', async () => {
      await loaded({ exactWordsEnabled: false, exactContent: null })
      const issues = [{ path: 'variants[0].body', code: 'blank_body', message: 'Body must not be blank' }]
      const saving = deferred<never>()
      apiMocks.saveDraft.mockReturnValueOnce(saving.promise)
      act(() => latest.setExactWordsEnabled(true))

      let pending: Promise<unknown> = Promise.resolve()
      act(() => { pending = latest.save().catch((error: unknown) => error) })
      act(() => latest.setExactContent({ chips: [], variants: [{ locale: 'en', body: 'Typed after sending', chipLabels: {} }] }))
      await act(async () => {
        saving.reject({ status: 400, error: { details: { issues } } })
        await pending
      })

      expect(latest.issues).toEqual([])
      expect(latest.dirty).toBe(true)
    })

    it('reports only the latest of two overlapping saves', async () => {
      await loaded({ exactWordsEnabled: false, exactContent: null })
      const first = deferred<{ greeting: AgentGreetingDraft; validation: { ok: true } }>()
      const second = deferred<{ greeting: AgentGreetingDraft; validation: { ok: true } }>()
      apiMocks.saveDraft.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

      act(() => latest.setExactWordsEnabled(true))
      let firstSave: Promise<void> = Promise.resolve()
      act(() => { firstSave = latest.save() })
      act(() => latest.setExactContent({ chips: [], variants: [{ locale: 'en', body: 'Second', chipLabels: {} }] }))
      let secondSave: Promise<void> = Promise.resolve()
      act(() => { secondSave = latest.save() })
      await act(async () => {
        second.resolve({ greeting: { exactWordsEnabled: true, exactContent: null }, validation: { ok: true } })
        await secondSave
      })
      expect(latest.dirty).toBe(false)

      await act(async () => {
        first.resolve({ greeting: { exactWordsEnabled: true, exactContent: null }, validation: { ok: true } })
        await firstSave
      })

      expect(latest.dirty).toBe(false)
      expect(latest.exactContent?.variants[0]?.body).toBe('Second')
    })
  })

  describe('loading', () => {
    it('ignores a read that answers after the agent has changed', async () => {
      const slow = deferred<AgentGreetingDraft>()
      const otherAgentId = '33333333-3333-4333-8333-333333333333'
      apiMocks.getDraft.mockReturnValueOnce(slow.promise)
      await render()
      apiMocks.getDraft.mockResolvedValueOnce({ exactWordsEnabled: false, exactContent: null })
      await render(otherAgentId)

      await act(async () => { slow.resolve({ exactWordsEnabled: true, exactContent: stored }) })

      expect(latest.loadState).toBe('ready')
      expect(latest.exactWordsEnabled).toBe(false)
      expect(latest.exactContent).toBeNull()
    })

    it('reads again, rather than bringing back what it held, when the page returns to the agent after not showing it', async () => {
      await loaded({ exactWordsEnabled: true, exactContent: stored })
      act(() => latest.setExactWordsEnabled(false))
      expect(latest.dirty).toBe(true)

      await render(null)
      const reading = deferred<AgentGreetingDraft>()
      apiMocks.getDraft.mockReturnValueOnce(reading.promise)
      await render(agentId)

      // While the new read is out, nothing of the old session is shown or saved.
      expect(latest.loadState).toBe('loading')
      expect(latest.dirty).toBe(false)
      await act(async () => { await latest.save() })
      expect(apiMocks.saveDraft).not.toHaveBeenCalled()

      await act(async () => { reading.resolve({ exactWordsEnabled: true, exactContent: stored }) })

      expect(apiMocks.getDraft).toHaveBeenCalledTimes(2)
      expect(latest.loadState).toBe('ready')
      expect(latest.exactWordsEnabled).toBe(true)
      expect(latest.dirty).toBe(false)
    })
  })

  describe('when the page leaves the agent and returns while a save is in flight', () => {
    const sent: ExactContentItem = { chips: [], variants: [{ locale: 'en', body: 'Hello!', chipLabels: {} }] }
    const startSaveThenLeaveAndReturn = async () => {
      await loaded({ exactWordsEnabled: true, exactContent: stored })
      const saving = deferred<{ greeting: AgentGreetingDraft; validation: { ok: true } }>()
      apiMocks.saveDraft.mockReturnValueOnce(saving.promise)
      act(() => latest.setExactContent(sent))
      let pending: Promise<void> = Promise.resolve()
      act(() => { pending = latest.save() })
      await render(null)
      return { saving, finish: async () => {
        await act(async () => {
          saving.resolve({ greeting: { exactWordsEnabled: true, exactContent: sent }, validation: { ok: true } })
          await pending
        })
      } }
    }

    it('does not set the saved wording as the baseline of a session that was read before the save landed', async () => {
      const { finish } = await startSaveThenLeaveAndReturn()
      apiMocks.getDraft.mockResolvedValueOnce({ exactWordsEnabled: true, exactContent: stored })
      await render(agentId)
      apiMocks.getDraft.mockResolvedValueOnce({ exactWordsEnabled: true, exactContent: sent })

      await finish()

      // Left as it was, the editor would hold the old wording against the saved one as an edit,
      // and the next Save draft would write the old wording over it.
      expect(latest.exactContent).toEqual(sent)
      expect(latest.dirty).toBe(false)
      await act(async () => { await latest.save() })
      expect(apiMocks.saveDraft).toHaveBeenCalledTimes(1)
    })

    it('reads again when the save landed while the read was out, since that read may predate it', async () => {
      const { finish } = await startSaveThenLeaveAndReturn()
      const reading = deferred<AgentGreetingDraft>()
      apiMocks.getDraft.mockReturnValueOnce(reading.promise)
      await render(agentId)
      apiMocks.getDraft.mockResolvedValueOnce({ exactWordsEnabled: true, exactContent: sent })

      await finish()
      expect(latest.loadState).toBe('loading')
      await act(async () => { reading.resolve({ exactWordsEnabled: true, exactContent: stored }) })

      expect(apiMocks.getDraft).toHaveBeenCalledTimes(3)
      expect(latest.loadState).toBe('ready')
      expect(latest.exactContent).toEqual(sent)
      expect(latest.dirty).toBe(false)
    })
  })

  describe('when something else writes the draft greeting', () => {
    const rays: ExactContentItem = { chips: [], variants: [{ locale: 'en', body: 'Ray wrote this', chipLabels: {} }] }

    it('reads it again into an editor that holds no edits', async () => {
      await loaded({ exactWordsEnabled: false, exactContent: null })
      apiMocks.getDraft.mockResolvedValueOnce({ exactWordsEnabled: true, exactContent: rays })

      await announceGreetingChanged()

      expect(latest.exactWordsEnabled).toBe(true)
      expect(latest.exactContent).toEqual(rays)
      expect(latest.dirty).toBe(false)
    })

    it('keeps the operator\'s edits when the editor holds some', async () => {
      await loaded({ exactWordsEnabled: false, exactContent: null })
      act(() => latest.setExactWordsEnabled(true))
      apiMocks.getDraft.mockResolvedValueOnce({ exactWordsEnabled: true, exactContent: rays })

      await announceGreetingChanged()

      expect(latest.exactContent).toBeNull()
      expect(latest.dirty).toBe(true)
    })

    it('measures the operator\'s edits against what Ray wrote, so putting the old wording back still counts as a change', async () => {
      await loaded({ exactWordsEnabled: false, exactContent: null })
      act(() => latest.setExactWordsEnabled(true))
      apiMocks.getDraft.mockResolvedValueOnce({ exactWordsEnabled: true, exactContent: rays })
      await announceGreetingChanged()

      act(() => latest.setExactWordsEnabled(false))

      expect(latest.dirty).toBe(true)
      await act(async () => { await latest.save() })
      expect(apiMocks.saveDraft).toHaveBeenLastCalledWith(agentId, { exactWordsEnabled: false, exactContent: null })
      expect(latest.dirty).toBe(false)
    })

    it('reads clean when the operator\'s edits come to match what Ray wrote', async () => {
      await loaded({ exactWordsEnabled: false, exactContent: null })
      act(() => latest.setExactWordsEnabled(true))
      act(() => latest.setExactContent(rays))
      expect(latest.dirty).toBe(true)
      apiMocks.getDraft.mockResolvedValueOnce({ exactWordsEnabled: true, exactContent: rays })

      await announceGreetingChanged()

      expect(latest.exactContent).toEqual(rays)
      expect(latest.dirty).toBe(false)
    })

    it('keeps edits typed while the read was in flight', async () => {
      await loaded({ exactWordsEnabled: false, exactContent: null })
      const reading = deferred<AgentGreetingDraft>()
      apiMocks.getDraft.mockReturnValueOnce(reading.promise)
      await announceGreetingChanged()

      act(() => latest.setExactWordsEnabled(true))
      await act(async () => { reading.resolve({ exactWordsEnabled: true, exactContent: rays }) })

      expect(latest.exactContent).toBeNull()
      expect(latest.dirty).toBe(true)
    })

    it('does not read the draft again after its own save', async () => {
      await loaded({ exactWordsEnabled: false, exactContent: null })
      act(() => latest.setExactWordsEnabled(true))
      await act(async () => { await latest.save().catch(() => undefined) })

      expect(apiMocks.getDraft).toHaveBeenCalledTimes(1)
    })

    it('does not apply a read that began before a save over what that save wrote', async () => {
      await loaded({ exactWordsEnabled: false, exactContent: null })
      const reading = deferred<AgentGreetingDraft>()
      apiMocks.getDraft.mockReturnValueOnce(reading.promise)
      await announceGreetingChanged()
      const mine: ExactContentItem = { chips: [], variants: [{ locale: 'en', body: 'Mine', chipLabels: {} }] }
      act(() => latest.setExactContent(mine))
      await act(async () => { await latest.save() })

      await act(async () => { reading.resolve({ exactWordsEnabled: false, exactContent: null }) })

      expect(latest.exactContent).toEqual(mine)
      expect(latest.dirty).toBe(false)
    })

    it('keeps the issues it is showing when the draft already holds what the editor holds', async () => {
      await loaded({ exactWordsEnabled: false, exactContent: null })
      const issues = [{ path: 'variants[0].body', code: 'unknown_reference', message: 'Unknown reference {{missing}}' }]
      const unknownReference: ExactContentItem = { chips: [], variants: [{ locale: 'en', body: 'Hi {{missing}}', chipLabels: {} }] }
      apiMocks.saveDraft.mockResolvedValueOnce({ greeting: { exactWordsEnabled: false, exactContent: unknownReference }, validation: { ok: false, issues } })
      act(() => latest.setExactContent(unknownReference))
      await act(async () => { await latest.save() })
      apiMocks.getDraft.mockResolvedValueOnce({ exactWordsEnabled: false, exactContent: unknownReference })

      await announceGreetingChanged()

      expect(latest.issues).toEqual(issues)
    })

    it('ignores a change to another agent\'s draft', async () => {
      await loaded({ exactWordsEnabled: false, exactContent: null })

      await announceGreetingChanged('33333333-3333-4333-8333-333333333333')

      expect(apiMocks.getDraft).toHaveBeenCalledTimes(1)
    })
  })
})
