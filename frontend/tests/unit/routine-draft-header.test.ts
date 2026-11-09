import { describe, expect, it } from 'vitest'

import type { RoutineDefinitionDraft } from '@/lib/api'
import {
  draftWithHeader,
  headerFromDraft,
  mergeDocumentHeaderChange,
} from '@/lib/routine-draft-header'

const draft = (activation: Partial<RoutineDefinitionDraft['activation']> = {}): RoutineDefinitionDraft => ({
  name: 'Book a room',
  activation: { triggerDescription: 'A guest wants to book a room', gateRef: null, priority: 0, ...activation },
  slots: [],
  steps: [{ stableStepId: 'step_1', kind: 'chat', instruction: 'Ask for the dates.', toolRef: null, actionType: null, ordinal: 0, metadata: {} }],
  transitions: [],
  terminals: [{ stableStepId: 'complete', kind: 'complete', instruction: 'Confirm.', ordinal: 0 }],
})

describe('routine draft header start mode (#1716)', () => {
  it('reads the start mode from a draft, an absent one as automatic', () => {
    expect(headerFromDraft(draft({ startMode: 'offer' })).activation.startMode).toBe('offer')
    expect(headerFromDraft(draft()).activation.startMode).toBe('automatic')
  })

  it('writes the header start mode onto the draft', () => {
    const header = { ...headerFromDraft(draft()), activation: { ...headerFromDraft(draft()).activation, startMode: 'offer' as const } }

    expect(draftWithHeader(draft(), header).activation.startMode).toBe('offer')
  })

  it('takes a start mode the document changed, and keeps the header one when the document did not touch it', () => {
    const currentHeader = headerFromDraft(draft({ startMode: 'automatic' }))

    const changedInDocument = mergeDocumentHeaderChange(draft({ startMode: 'offer' }), draft({ startMode: 'automatic' }), currentHeader)
    expect(changedInDocument.activation.startMode).toBe('offer')

    const offerInHeader = { ...currentHeader, activation: { ...currentHeader.activation, startMode: 'offer' as const } }
    const untouchedInDocument = mergeDocumentHeaderChange(draft({ startMode: 'automatic', priority: 3 }), draft({ startMode: 'automatic' }), offerInHeader)
    expect(untouchedInDocument.activation.startMode).toBe('offer')
    expect(untouchedInDocument.activation.priority).toBe(3)
  })
})
