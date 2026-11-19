import { eventTrigger, sampleEvent } from '../lib/event_triggers.js'

export default eventTrigger({
  key: 'document_failed',
  type: 'document.failed',
  noun: 'Document',
  label: 'Document Failed',
  description: 'Triggers when processing a document revision fails for good, with the failure code.',
  subject: 'document',
  detailFields: [{ key: 'data__failureCode', label: 'Failure code' }],
  sample: sampleEvent('document.failed', { failureCode: 'provider_misconfigured' }, 'document'),
})
