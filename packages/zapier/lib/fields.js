'use strict'

/** The "Agent" dropdown, filled by the hidden `agent` trigger. */
const agentField = ({ required, helpText }) => ({
  key: 'agent_id',
  label: 'Agent',
  required,
  dynamic: 'agent.id.name',
  helpText,
})

module.exports = { agentField }
