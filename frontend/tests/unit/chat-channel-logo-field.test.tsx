/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { LogoField } from '@/components/dashboard/settings/chat-channel-section'

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

describe('chat channel logo field', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  it('falls back from a broken admin logo image and retries when the logo URL changes', () => {
    const renderField = (logoUrl: string) => {
      root.render(
        <LogoField
          logoUrl={logoUrl}
          busy={false}
          isSaving={false}
          onUpload={() => undefined}
          onDelete={() => undefined}
        />,
      )
    }

    act(() => {
      renderField('/backend/api/v1/public/chat/old-token/assistant-logo')
    })
    expect(container.querySelector('img[src="/backend/api/v1/public/chat/old-token/assistant-logo"]')).not.toBeNull()

    act(() => {
      container.querySelector('img')?.dispatchEvent(new Event('error', { bubbles: true }))
    })
    expect(container.querySelector('img')).toBeNull()

    act(() => {
      renderField('/backend/api/v1/public/chat/new-token/assistant-logo')
    })
    expect(container.querySelector('img[src="/backend/api/v1/public/chat/new-token/assistant-logo"]')).not.toBeNull()
  })
})
