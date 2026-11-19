import { radiosoRequest } from '../lib/client.js'

const TRANSCRIPT_MESSAGE_LIMIT = 100

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The transcript carries message text only. The conversation's visitor profile and request
 * context (which holds an IP address) stay out of the Zap's data. Lines are labelled by who
 * wrote them (`source`), so a teammate's reply is not shown as the agent's.
 */
const transcriptLine = (message) => `${message.source || message.role}: ${message.content}`

const findConversation = async (z, bundle) => {
  const conversationId = String(bundle.inputData.conversation_id || '').trim()
  if (!UUID.test(conversationId)) return []
  const conversation = await radiosoRequest(z, bundle, {
    path: `/history/chat/${encodeURIComponent(conversationId)}`,
    params: { limit: TRANSCRIPT_MESSAGE_LIMIT },
    allowNotFound: true,
  })
  if (!conversation) return []

  const messages = (conversation.messages || []).filter((message) => message.role !== 'system')
  return [
    {
      id: conversation.conversationId,
      conversation_id: conversation.conversationId,
      agent_id: conversation.agentId || null,
      agent_name: conversation.agentName || null,
      source_channel: conversation.sourceChannel || null,
      title: conversation.title || null,
      created_at: conversation.createdAt,
      updated_at: conversation.updatedAt,
      message_count: conversation.messageCount,
      conversation_owner: conversation.ownership ? conversation.ownership.state : 'ai_owned',
      transcript: messages.map(transcriptLine).join('\n'),
      transcript_is_partial: Boolean(conversation.hasOlderMessages),
    },
  ]
}

export default {
  key: 'find_conversation',
  noun: 'Conversation',
  display: {
    label: 'Find Conversation',
    description: 'Finds a saved conversation by its ID and returns its details and transcript.',
  },
  operation: {
    inputFields: [
      {
        key: 'conversation_id',
        label: 'Conversation ID',
        required: true,
        helpText: 'The Conversation ID from an earlier Ask an Agent step.',
      },
    ],
    perform: findConversation,
    sample: {
      id: '9c0a1b6e-5a43-4c61-a1f8-2d7e0c7f3b10',
      conversation_id: '9c0a1b6e-5a43-4c61-a1f8-2d7e0c7f3b10',
      agent_id: '0f6b3a52-7c1e-4d0e-9a4b-3d2f6a1c8e10',
      agent_name: 'Support agent',
      source_channel: 'website_embed',
      title: 'Return window question',
      created_at: '2026-11-19T09:12:00.000Z',
      updated_at: '2026-11-19T09:13:10.000Z',
      message_count: 2,
      conversation_owner: 'ai_owned',
      transcript: 'customer: How long do I have to return an item?\nai_agent: You can return an item within 30 days of delivery.',
      transcript_is_partial: false,
    },
    outputFields: [
      { key: 'conversation_id', label: 'Conversation ID' },
      { key: 'agent_name', label: 'Agent name' },
      { key: 'source_channel', label: 'Channel' },
      { key: 'title', label: 'Title' },
      { key: 'message_count', label: 'Message count', type: 'integer' },
      { key: 'conversation_owner', label: 'Conversation owner (ai_owned or human_owned)' },
      { key: 'transcript', label: 'Transcript' },
      { key: 'transcript_is_partial', label: 'Transcript is partial', type: 'boolean' },
    ],
  },
}
