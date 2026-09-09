import { describe, expect, it, vi } from 'vitest'

import {
  isAgentDraftDirty,
  registerAgentDraftSaver,
  saveAgentDraft,
} from '@/lib/agent-draft-save-port'

describe('agent draft save port', () => {
  it('requires a mounted editor and awaits its real save promise', async () => {
    await expect(saveAgentDraft('missing-agent')).rejects.toThrow('editor is not ready')

    let resolveSave: (() => void) | undefined
    const save = vi.fn(() => new Promise<void>((resolve) => { resolveSave = resolve }))
    const unregister = registerAgentDraftSaver('agent-1', { save, isDirty: () => true })

    expect(isAgentDraftDirty('agent-1')).toBe(true)
    const pending = saveAgentDraft('agent-1')
    expect(save).toHaveBeenCalledOnce()
    let settled = false
    void pending.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    resolveSave?.()
    await pending
    expect(settled).toBe(true)

    unregister()
    expect(isAgentDraftDirty('agent-1')).toBe(false)
    await expect(saveAgentDraft('agent-1')).rejects.toThrow('editor is not ready')
  })
})
