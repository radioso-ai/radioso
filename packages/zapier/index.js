'use strict'

const { version: platformVersion } = require('zapier-platform-core')
const { version } = require('./package.json')

const authentication = require('./authentication')
const agent = require('./triggers/agent')
const askAgent = require('./creates/ask_agent')
const searchKnowledge = require('./creates/search_knowledge')
const addDocument = require('./creates/add_document')
const findConversation = require('./searches/find_conversation')

module.exports = {
  version,
  platformVersion,
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
