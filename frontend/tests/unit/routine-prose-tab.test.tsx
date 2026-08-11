/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { RoutineProseTab } from '@/components/dashboard/settings/routine-prose-tab'
import { draftFromChipDoc } from '@/lib/routine-prose'

const source = draftFromChipDoc({
  name: 'Refund review',
  trigger: 'When a customer requests a refund',
  variables: [],
  blocks: [
    { text: 'Review the purchase details.', chips: [] },
    { text: 'Explain the refund outcome.', chips: [] },
  ],
})

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

describe('RoutineProseTab', () => {
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

  it('emits the loaded multi-step routine after the editor mounts', () => {
    const onDraftChange = vi.fn()

    act(() => {
      root.render(
        <RoutineProseTab
          source={source}
          header={{ name: source.name, activation: { triggerDescription: source.activation.triggerDescription, priority: '0', reentryMode: 'once_per_conversation' } }}
          webhookDestinations={[]}
          isWebhookDestinationsLoading={false}
          webhookDestinationsError={null}
          onDraftChange={onDraftChange}
        />,
      )
    })

    const emitted = onDraftChange.mock.calls.at(-1)?.[0]
    expect(emitted?.steps).toEqual(source.steps)
  })
})
