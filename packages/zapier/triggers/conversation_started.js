import { eventTrigger, sampleEvent } from '../lib/event_triggers.js'

export default eventTrigger({
  key: 'conversation_started',
  type: 'conversation.started',
  noun: 'Conversation',
  label: 'New Conversation',
  description: 'Triggers when a new conversation starts with an agent.',
  detailFields: [],
  sample: sampleEvent('conversation.started', {}),
})
