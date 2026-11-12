import { describe, expect, it } from 'vitest'

import {
  readVisitorImageInput,
  visitorMessageBody,
  withVisitorImageInput,
} from '@/lib/visitor-image-input'
import type { ChatUserInputMetadata } from '@/lib/api-types'

const imageId = (n: number) => `00000000-0000-4000-8000-00000000000${n}`

describe('reading imageInput from a history message', () => {
  it('returns the typed text and each photo with its reading', () => {
    const imageInput = readVisitorImageInput({
      method: 'typed',
      imageInput: {
        typedText: 'Something like this, near the coast',
        images: [
          { id: imageId(1), reading: 'A stone farmhouse with green shutters.' },
          { id: imageId(2), reading: null },
        ],
      },
    })
    expect(imageInput).toEqual({
      typedText: 'Something like this, near the coast',
      images: [
        { id: imageId(1), reading: 'A stone farmhouse with green shutters.' },
        { id: imageId(2), reading: null },
      ],
    })
  })

  it('is null for a message without photos', () => {
    expect(readVisitorImageInput({ method: 'typed' })).toBeNull()
    expect(readVisitorImageInput(undefined)).toBeNull()
  })

  it('is null for a malformed record, so the message falls back to its content', () => {
    expect(readVisitorImageInput({ method: 'typed', imageInput: 'photo' })).toBeNull()
    expect(readVisitorImageInput({ method: 'typed', imageInput: { typedText: 4, images: [] } })).toBeNull()
    expect(readVisitorImageInput({ method: 'typed', imageInput: { typedText: 'hi', images: [] } })).toBeNull()
    expect(readVisitorImageInput({ method: 'typed', imageInput: { typedText: 'hi', images: [{ id: 1 }] } })).toBeNull()
  })

  it('keeps the photos that are well formed when one is not', () => {
    const imageInput = readVisitorImageInput({
      method: 'typed',
      imageInput: { typedText: '', images: [{ id: imageId(1), reading: 'A lamp.' }, { id: 7 }] },
    })
    expect(imageInput?.images).toEqual([{ id: imageId(1), reading: 'A lamp.' }])
  })
})

describe('what a visitor message shows', () => {
  it('shows the typed text and the photos, never the content with its reading blocks', () => {
    const body = visitorMessageBody({
      content: 'Something like this\n<visitor_image index="1">A stone farmhouse.</visitor_image>',
      inputMetadata: {
        method: 'typed',
        imageInput: { typedText: 'Something like this', images: [{ id: imageId(1), reading: 'A stone farmhouse.' }] },
      },
    })
    expect(body).toEqual({
      kind: 'images',
      typedText: 'Something like this',
      images: [{ id: imageId(1), reading: 'A stone farmhouse.' }],
    })
  })

  it('shows photos alone when the visitor typed nothing', () => {
    const body = visitorMessageBody({
      content: '<visitor_image index="1" unread/>',
      inputMetadata: { method: 'typed', imageInput: { typedText: '', images: [{ id: imageId(1), reading: null }] } },
    })
    expect(body).toMatchObject({ kind: 'images', typedText: '' })
  })

  it('shows a plain message as its content', () => {
    expect(visitorMessageBody({ content: 'When do you open?', inputMetadata: { method: 'typed' } }))
      .toEqual({ kind: 'text', text: 'When do you open?' })
    expect(visitorMessageBody({ content: 'Hello' })).toEqual({ kind: 'text', text: 'Hello' })
  })
})

describe('the optimistic message', () => {
  it('records what the visitor typed and the photos they sent, without a reading yet', () => {
    const metadata = withVisitorImageInput({ method: 'typed' }, 'Like this one', [imageId(1), imageId(2)])
    expect(metadata).toEqual({
      method: 'typed',
      imageInput: {
        typedText: 'Like this one',
        images: [{ id: imageId(1), reading: null }, { id: imageId(2), reading: null }],
      },
    })
    expect(readVisitorImageInput(metadata)?.images).toHaveLength(2)
  })

  it('records the photos on a message that carries no input metadata of its own', () => {
    expect(withVisitorImageInput(undefined, '', [imageId(1)])).toEqual({
      method: 'typed',
      imageInput: { typedText: '', images: [{ id: imageId(1), reading: null }] },
    })
  })

  it('leaves a message without photos as it was', () => {
    const metadata: ChatUserInputMetadata = { method: 'typed' }
    expect(withVisitorImageInput(metadata, 'hello', [])).toBe(metadata)
    expect(withVisitorImageInput(undefined, 'hello', [])).toBeUndefined()
  })
})
