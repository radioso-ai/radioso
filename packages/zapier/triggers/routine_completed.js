import { eventTrigger, sampleEvent } from '../lib/event_triggers.js'

export default eventTrigger({
  key: 'routine_completed',
  type: 'routine.completed',
  noun: 'Routine Run',
  label: 'Routine Completed',
  description: 'Triggers when a routine run ends, with the values it collected. Sensitive values read [redacted].',
  detailFields: [
    { key: 'data__routineId', label: 'Routine ID' },
    { key: 'data__executionId', label: 'Run ID' },
    { key: 'data__outcome', label: 'Outcome' },
    { key: 'data__values', label: 'Collected values' },
    { key: 'data__sensitiveSlotKeys', label: 'Sensitive value keys' },
  ],
  sample: sampleEvent('routine.completed', {
    routineId: 'book-a-visit',
    executionId: '8f3a1c52-0d7e-4b94-a6c1-5e2f9b0d3a78',
    outcome: 'complete',
    values: { name: 'Sam Example', date: '2026-02-03' },
    sensitiveSlotKeys: [],
  }),
})
