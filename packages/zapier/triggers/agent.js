'use strict'

const { radiosoRequest } = require('../lib/client')

/**
 * Hidden trigger that feeds the "Agent" dropdown on actions (`dynamic: 'agent.id.name'`). It is
 * never offered as a trigger a Zap can start from.
 */
const listAgents = async (z, bundle) => {
  const body = await radiosoRequest(z, bundle, { path: '/agents' })
  return (body.agents || []).map((agent) => ({ id: agent.id, name: agent.name }))
}

module.exports = {
  key: 'agent',
  noun: 'Agent',
  display: {
    label: 'Agent',
    description: 'Lists the agents in the workspace for dropdowns.',
    hidden: true,
  },
  operation: {
    perform: listAgents,
    sample: { id: '0f6b3a52-7c1e-4d0e-9a4b-3d2f6a1c8e10', name: 'Support agent' },
  },
}
