// Where a routine ending's "Notify the team" notice goes: the default destination and each notify
// skill an ending can name, as GET /agents/{agentId}/operator-notice-destinations reports them.

const operatorNoticeRoutes = ['named_skill', 'contact_human', 'contact_human_off', 'agent_setting', 'workspace_owner', 'none'] as const

type OperatorNoticeRoute = (typeof operatorNoticeRoutes)[number]

export interface OperatorNoticeDestination {
  skillName: string | null
  via: OperatorNoticeRoute
  recipientEmails: string[]
  recipientsFromWorkspaceOwner: boolean
  webhookConfigured: boolean
}

export interface OperatorNoticeDestinations {
  default: OperatorNoticeDestination
  skills: OperatorNoticeDestination[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const parseDestination = (value: unknown): OperatorNoticeDestination => {
  if (!isRecord(value)) throw new Error('A notice destination must be an object.')
  const { skillName, via, recipientEmails, recipientsFromWorkspaceOwner, webhookConfigured } = value
  if (skillName !== null && typeof skillName !== 'string') throw new Error('A notice destination has an invalid skill name.')
  if (!operatorNoticeRoutes.includes(via as OperatorNoticeRoute)) throw new Error('A notice destination has an unknown route.')
  if (!Array.isArray(recipientEmails) || !recipientEmails.every((email) => typeof email === 'string')) {
    throw new Error('A notice destination has invalid recipients.')
  }
  if (typeof recipientsFromWorkspaceOwner !== 'boolean' || typeof webhookConfigured !== 'boolean') {
    throw new Error('A notice destination is missing its flags.')
  }
  return { skillName, via: via as OperatorNoticeRoute, recipientEmails, recipientsFromWorkspaceOwner, webhookConfigured }
}

export const parseOperatorNoticeDestinations = (payload: unknown): OperatorNoticeDestinations => {
  if (!isRecord(payload) || !Array.isArray(payload.skills)) throw new Error('Notice destinations must include skills.')
  return { default: parseDestination(payload.default), skills: payload.skills.map(parseDestination) }
}

// Who receives a notice sent this way, or why nothing is sent.
const destinationTarget = (destination: OperatorNoticeDestination): { sent: true; to: string } | { sent: false; reason: string } => {
  if (destination.via === 'contact_human_off') return { sent: false, reason: 'contact_human is turned off' }
  const emails = destination.recipientEmails.join(', ')
  const owner = destination.recipientsFromWorkspaceOwner ? ' (workspace owner)' : ''
  if (emails && destination.webhookConfigured) return { sent: true, to: `${emails}${owner} and a webhook` }
  if (emails) return { sent: true, to: `${emails}${owner}` }
  return destination.webhookConfigured ? { sent: true, to: 'a webhook' } : { sent: false, reason: 'no recipient is set up' }
}

/**
 * The one line under "Send with": where the chosen option sends. A name the agent no longer offers
 * falls back to the default destination when the notice is sent, so the line says so.
 */
export const describeNoticeDestination = (
  destinations: OperatorNoticeDestinations | null,
  skillName: string | undefined,
): string | null => {
  if (!destinations) return null
  const named = skillName ? destinations.skills.find((destination) => destination.skillName === skillName) : destinations.default
  if (named) {
    const target = destinationTarget(named)
    return target.sent ? `Sends to ${target.to}` : `Not sent: ${target.reason}`
  }
  const fallback = destinationTarget(destinations.default)
  return fallback.sent
    ? `Unavailable, so it sends to the default: ${fallback.to}`
    : `Unavailable, and the default is not sent: ${fallback.reason}`
}

const DEFAULT_ROUTE_LABELS: Partial<Record<OperatorNoticeRoute, string>> = {
  contact_human: 'contact_human',
  agent_setting: 'agent contact settings',
  workspace_owner: 'workspace owner',
}

/** The "Send with" option for an ending that names no skill, named for the rule it follows. */
export const defaultNoticeDestinationLabel = (destination: OperatorNoticeDestination | undefined): string => {
  const route = destination ? DEFAULT_ROUTE_LABELS[destination.via] : undefined
  return route ? `Default (${route})` : 'Default'
}
