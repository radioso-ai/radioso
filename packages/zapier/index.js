import zapier from 'zapier-platform-core'

import authentication from './authentication.js'
import addDocument from './creates/add_document.js'
import askAgent from './creates/ask_agent.js'
import searchKnowledge from './creates/search_knowledge.js'
import findConversation from './searches/find_conversation.js'
import agent from './triggers/agent.js'
import pkg from './package.json' with { type: 'json' }

export default {
  version: pkg.version,
  platformVersion: zapier.version,
  flags: { cleanInputData: false },
  authentication,
  triggers: { [agent.key]: agent },
  creates: {
    [askAgent.key]: askAgent,
    [searchKnowledge.key]: searchKnowledge,
    [addDocument.key]: addDocument,
  },
  searches: { [findConversation.key]: findConversation },
}
