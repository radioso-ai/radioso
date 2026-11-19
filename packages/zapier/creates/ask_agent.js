'use strict'

const { radiosoRequest } = require('../lib/client')
const { agentField } = require('../lib/fields')

const askAgent = async (z, bundle) => {
  const input = bundle.inputData
  const request = { message: input.message }
  if (input.agent_id) request.agentId = input.agent_id
  if (input.conversation_id) request.conversationId = input.conversation_id
  if (input.locale) request.userExpectedLocale = input.locale

  const reply = await radiosoRequest(z, bundle, { method: 'POST', path: '/assistant/chat', body: request })
  const citations = (reply.citations || []).map((citation) => ({
    title: citation.title,
    url: citation.sourceUrl || null,
  }))
  return {
    id: reply.assistantMessageId,
    conversation_id: reply.conversationId,
    assistant_message_id: reply.assistantMessageId,
    agent_id: reply.agentId || null,
    agent_name: reply.agentName || null,
    answer: reply.answer,
    citations,
    conversation_owner: reply.ownership ? reply.ownership.state : null,
    reply_suppressed: reply.ownership ? reply.ownership.suppressed : false,
  }
}

module.exports = {
  key: 'ask_agent',
  noun: 'Answer',
  display: {
    label: 'Ask an Agent',
    description:
      "Sends a message to a Radioso agent and returns its answer. Zapier stops an action after about 30 seconds, so a turn that runs a long routine or several skills can time out as a failed step.",  },
  operation: {
    inputFields: [
      { key: 'message', label: 'Message', required: true, helpText: 'Up to 4,000 characters.' },
      agentField({
        required: false,
        helpText: 'The agent to ask. Leave empty to use the workspace default agent.',
      }),
      {
        key: 'conversation_id',
        label: 'Conversation ID',
        required: false,
        helpText:
          'Leave empty to start a new conversation. Map the Conversation ID from an earlier Ask an Agent step to continue it.',
      },
      {
        key: 'locale',
        label: 'Expected language',
        required: false,
        helpText: 'A language tag such as `en` or `de`. Leave empty to let the agent follow the message.',
      },
    ],
    perform: askAgent,
    sample: {
      id: '5d1c2c3e-0b4a-4e0a-8f7a-6a5f0f1b2c31',
      conversation_id: '9c0a1b6e-5a43-4c61-a1f8-2d7e0c7f3b10',
      assistant_message_id: '5d1c2c3e-0b4a-4e0a-8f7a-6a5f0f1b2c31',
      agent_id: '0f6b3a52-7c1e-4d0e-9a4b-3d2f6a1c8e10',
      agent_name: 'Support agent',
      answer: 'You can return an item within 30 days of delivery.',
      citations: [{ title: 'Returns policy', url: 'https://docs.example/returns' }],
      conversation_owner: 'ai_owned',
      reply_suppressed: false,
    },
    outputFields: [
      { key: 'conversation_id', label: 'Conversation ID' },
      { key: 'assistant_message_id', label: 'Assistant message ID' },
      { key: 'agent_id', label: 'Agent ID' },
      { key: 'agent_name', label: 'Agent name' },
      { key: 'answer', label: 'Answer' },
      { key: 'conversation_owner', label: 'Conversation owner (ai_owned or human_owned)' },
      { key: 'reply_suppressed', label: 'Reply suppressed', type: 'boolean' },
    ],
  },
}
