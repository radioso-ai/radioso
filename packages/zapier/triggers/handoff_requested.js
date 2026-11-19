import { eventTrigger, sampleEvent } from '../lib/event_triggers.js'

export default eventTrigger({
  key: 'handoff_requested',
  type: 'handoff.requested',
  noun: 'Handoff',
  label: 'Handoff Requested',
  description: 'Triggers when a conversation is handed to a person.',
  detailFields: [{ key: 'data__reason', label: 'Handoff reason' }],
  sample: sampleEvent('handoff.requested', { reason: 'routine_handoff' }),
})
