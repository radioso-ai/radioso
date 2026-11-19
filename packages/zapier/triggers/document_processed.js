import { eventTrigger, sampleEvent } from '../lib/event_triggers.js'

export default eventTrigger({
  key: 'document_processed',
  type: 'document.processed',
  noun: 'Document',
  label: 'Document Processed',
  description:
    'Triggers when a document revision finishes processing and is ready for retrieval. A website crawl or connector sync triggers once per page it adds or changes.',
  subject: 'document',
  detailFields: [],
  sample: sampleEvent('document.processed', {}, 'document'),
})
