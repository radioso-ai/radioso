import { eventTrigger, sampleEvent } from '../lib/event_triggers.js'

export default eventTrigger({
  key: 'contact_request_created',
  type: 'contact_request.created',
  noun: 'Contact Request',
  label: 'New Contact Request',
  description: 'Triggers when a visitor leaves a contact request for the team.',
  detailFields: [
    { key: 'data__contactRequestId', label: 'Contact request ID' },
    { key: 'data__values', label: 'Collected values' },
  ],
  sample: sampleEvent('contact_request.created', {
    contactRequestId: '2d8e6f10-9a3b-4c57-b1e4-6f0a8c2d4e71',
    values: { name: 'Sam Example', email: 'sam@example.com' },
  }),
})
