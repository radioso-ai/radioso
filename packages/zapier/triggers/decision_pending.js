import { eventTrigger, sampleEvent } from '../lib/event_triggers.js'

export default eventTrigger({
  key: 'decision_pending',
  type: 'decision.pending',
  noun: 'Decision',
  label: 'Decision Pending',
  description:
    'Triggers when a routine waits for a person to decide. This only notifies: decisions are resolved in the Radioso Inbox.',
  detailFields: [
    { key: 'data__decisionHandle', label: 'Decision handle' },
    { key: 'data__routineId', label: 'Routine ID' },
    { key: 'data__stepId', label: 'Step ID' },
    { key: 'data__reason', label: 'Reason' },
    { key: 'data__options', label: 'Options' },
    { key: 'data__deadline', label: 'Deadline', type: 'datetime' },
  ],
  sample: sampleEvent('decision.pending', {
    decisionHandle: 'dh_3f9a1c',
    routineId: 'approve-refund',
    stepId: 'review',
    reason: 'Refund above the automatic limit',
    options: [
      { id: 'approve', label: 'Approve' },
      { id: 'decline', label: 'Decline' },
    ],
    deadline: null,
  }),
})
