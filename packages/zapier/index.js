import zapier from 'zapier-platform-core'

import authentication from './authentication.js'
import addDocument from './creates/add_document.js'
import askAgent from './creates/ask_agent.js'
import searchKnowledge from './creates/search_knowledge.js'
import findConversation from './searches/find_conversation.js'
import agent from './triggers/agent.js'
import contactRequestCreated from './triggers/contact_request_created.js'
import conversationStarted from './triggers/conversation_started.js'
import decisionPending from './triggers/decision_pending.js'
import documentFailed from './triggers/document_failed.js'
import documentProcessed from './triggers/document_processed.js'
import handoffRequested from './triggers/handoff_requested.js'
import routineCompleted from './triggers/routine_completed.js'
import pkg from './package.json' with { type: 'json' }

export default {
  version: pkg.version,
  platformVersion: zapier.version,
  flags: { cleanInputData: false },
  authentication,
  triggers: Object.fromEntries(
    [
      agent,
      conversationStarted,
      contactRequestCreated,
      handoffRequested,
      routineCompleted,
      decisionPending,
      documentProcessed,
      documentFailed,
    ].map((trigger) => [trigger.key, trigger]),
  ),
  creates: {
    [askAgent.key]: askAgent,
    [searchKnowledge.key]: searchKnowledge,
    [addDocument.key]: addDocument,
  },
  searches: { [findConversation.key]: findConversation },
}
