/* @vitest-environment jsdom */

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAgentDraftWriter } from '@/components/dashboard/settings/use-agent-draft-writer'
import { useSettingsSaveStatus } from '@/components/dashboard/settings/use-settings-save-status'

interface Inputs {
  ready?: boolean
  hasInstructionChanges: boolean
  hasGreetingChanges: boolean
  writeInstructions: (isLatest: () => boolean) => Promise<void>
  writeGreeting: () => Promise<void>
}

describe('useAgentDraftWriter', () => {
  let container: HTMLDivElement
  let root: Root
  let writer: ReturnType<typeof useAgentDraftWriter>
  let page: {
    saveState: string
    saveError: string | null
    settingsError: string | null
    setSaveState: (state: 'idle' | 'saved' | 'saving' | 'error') => void
    setSaveError: (message: string | null) => void
    setSettingsError: (message: string | null) => void
  }
  const onDraftMoved = vi.fn()

  beforeAll(() => {
    // React 19 reads this to decide whether act() may drive updates.
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  const Harness = (inputs: Inputs) => {
    const save = useSettingsSaveStatus()
    const [settingsError, setSettingsError] = useState<string | null>(null)
    writer = useAgentDraftWriter({
      ...inputs,
      ready: inputs.ready ?? true,
      onDraftMoved,
      status: { saveError: save.saveError, setSaveState: save.setSaveState, setSaveError: save.setSaveError, setSettingsError },
    })
    page = { saveState: save.saveState, saveError: save.saveError, settingsError, setSaveState: save.setSaveState, setSaveError: save.setSaveError, setSettingsError }
    return null
  }

  const render = async (inputs: Inputs) => {
    await act(async () => root.render(<Harness {...inputs} />))
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

  const written = (): Inputs => ({
    hasInstructionChanges: true,
    hasGreetingChanges: true,
    writeInstructions: vi.fn(async () => undefined),
    writeGreeting: vi.fn(async () => undefined),
  })

  beforeEach(() => {
    onDraftMoved.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('writes what changed, reports the draft saved, and tells readers of the draft once', async () => {
    const inputs = written()
    await render(inputs)

    await act(async () => { await writer.write() })

    expect(inputs.writeInstructions).toHaveBeenCalledOnce()
    expect(inputs.writeGreeting).toHaveBeenCalledOnce()
    expect(page.saveState).toBe('saved')
    expect(page.settingsError).toBeNull()
    expect(onDraftMoved).toHaveBeenCalledTimes(1)
  })

  it('writes only the instructions when only they changed, and nothing when nothing changed', async () => {
    const instructionsOnly = { ...written(), hasGreetingChanges: false }
    await render(instructionsOnly)
    await act(async () => { await writer.write() })
    expect(instructionsOnly.writeInstructions).toHaveBeenCalledOnce()
    expect(onDraftMoved).toHaveBeenCalledTimes(1)

    onDraftMoved.mockReset()
    const nothing = { ...written(), hasInstructionChanges: false, hasGreetingChanges: false }
    await render(nothing)
    await act(async () => { await writer.write() })
    expect(nothing.writeInstructions).not.toHaveBeenCalled()
    expect(nothing.writeGreeting).not.toHaveBeenCalled()
    expect(onDraftMoved).not.toHaveBeenCalled()
  })

  it('refuses to write before the editor has loaded', async () => {
    const inputs = { ...written(), ready: false }
    await render(inputs)

    await expect(writer.write()).rejects.toThrow('still loading')
    expect(inputs.writeInstructions).not.toHaveBeenCalled()
  })

  it('tells readers of the draft once when the instructions landed and the greeting was refused', async () => {
    const refusal = new Error('Exact greeting content is invalid')
    const inputs = { ...written(), writeGreeting: vi.fn(async () => { throw refusal }) }
    await render(inputs)

    await act(async () => { await expect(writer.write()).rejects.toBe(refusal) })

    expect(onDraftMoved).toHaveBeenCalledTimes(1)
    expect(page.saveState).toBe('error')
    expect(page.saveError).toBe('Failed to save draft changes')
    expect(page.settingsError).toBe('Exact greeting content is invalid')
  })

  it('does not tell readers of the draft when nothing landed', async () => {
    const inputs = { ...written(), writeInstructions: vi.fn(async () => { throw new Error('network down') }) }
    await render(inputs)

    await act(async () => { await expect(writer.write()).rejects.toThrow('network down') })

    expect(inputs.writeGreeting).not.toHaveBeenCalled()
    expect(onDraftMoved).not.toHaveBeenCalled()
  })

  it('lets a newer save\'s failure stand when an older save succeeds after it', async () => {
    const olderGreeting = deferred<void>()
    const older = { ...written(), writeGreeting: vi.fn(() => olderGreeting.promise) }
    await render(older)
    let olderSave: Promise<void> = Promise.resolve()
    await act(async () => { olderSave = writer.write() })

    const newer = { ...written(), hasInstructionChanges: false, writeGreeting: vi.fn(async () => { throw new Error('Exact greeting content is invalid') }) }
    await render(newer)
    await act(async () => { await expect(writer.write()).rejects.toThrow() })
    expect(page.saveState).toBe('error')

    await act(async () => {
      olderGreeting.resolve()
      await olderSave
    })

    expect(page.saveState).toBe('error')
    expect(page.settingsError).toBe('Exact greeting content is invalid')
  })

  describe('releasing a failure', () => {
    const failDraftSave = async () => {
      const inputs = { ...written(), writeGreeting: vi.fn(async () => { throw new Error('Exact greeting content is invalid') }) }
      await render(inputs)
      await act(async () => { await expect(writer.write()).rejects.toThrow() })
      return inputs
    }

    it('clears the failure the draft save put on the page', async () => {
      const inputs = await failDraftSave()
      await render(inputs)

      await act(async () => writer.releaseFailure())

      expect(page.saveState).toBe('idle')
      expect(page.saveError).toBeNull()
      expect(page.settingsError).toBeNull()
    })

    it('leaves a failure a different save has shown since', async () => {
      const inputs = await failDraftSave()
      await act(async () => {
        page.setSettingsError('Failed to update assistant settings.')
        page.setSaveState('error')
        page.setSaveError('Failed to save changes')
      })
      await render(inputs)

      await act(async () => writer.releaseFailure())

      expect(page.saveState).toBe('error')
      expect(page.saveError).toBe('Failed to save changes')
      expect(page.settingsError).toBe('Failed to update assistant settings.')
    })

    it('does not lift a saving status another save is showing', async () => {
      const inputs = await failDraftSave()
      await act(async () => {
        page.setSaveState('saving')
        page.setSaveError(null)
      })
      await render(inputs)

      await act(async () => writer.releaseFailure())

      expect(page.saveState).toBe('saving')
    })

    it('has nothing to release when the draft save did not fail', async () => {
      await render(written())
      await act(async () => {
        page.setSettingsError('Failed to update assistant settings.')
        page.setSaveState('error')
        page.setSaveError('Failed to save changes')
      })

      await act(async () => writer.releaseFailure())

      expect(page.settingsError).toBe('Failed to update assistant settings.')
      expect(page.saveState).toBe('error')
    })
  })
})
