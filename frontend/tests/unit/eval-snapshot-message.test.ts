import { describe, expect, it } from 'vitest'

import { snapshotInputMetadata } from '@/lib/eval-snapshot-message'
import type { EvalSnapshotMessage } from '@/lib/api-eval'

const message = (overrides: Partial<EvalSnapshotMessage> = {}): EvalSnapshotMessage => ({
  id: 'message-1',
  role: 'user',
  content: 'Something like this\n<attached_photo index="1">A stone farmhouse.</attached_photo>',
  createdAt: '2026-06-30T10:00:00.000Z',
  ...overrides,
})

describe('what a thread reads of an Eval snapshot message', () => {
  it('is the photos the message carried, so the thread shows the typed words and the photos, not the readings in content', () => {
    const imageInput = {
      typedText: 'Something like this',
      images: [{ id: '6c3e9f2a-1d4b-4b8e-9f0a-2a4c6e8b0d12', reading: 'A stone farmhouse.' }],
    }

    expect(snapshotInputMetadata(message({ imageInput }))).toEqual({ method: 'typed', imageInput })
  })

  it('is nothing for a message without photos, and for a snapshot captured before photos were kept', () => {
    expect(snapshotInputMetadata(message())).toBeUndefined()
    expect(snapshotInputMetadata(message({ role: 'assistant' }))).toBeUndefined()
  })
})
