import { type AgentTab, type DashboardRouteState } from '@/lib/dashboard-routes'

/**
 * An "area" is a top-level destination that owns a second navigation column.
 * It maps 1:1 to a section, so the rail highlight and the rendered content key
 * off the same value — no divergent mappings.
 */
export type DashboardArea = 'agents' | 'knowledge' | 'settings' | 'account'

/** The area whose sub-nav should show, or null for areas without one. */
export function activeArea(routeState: Pick<DashboardRouteState, 'section'>): DashboardArea | null {
  switch (routeState.section) {
    case 'agents':
      return 'agents'
    case 'knowledge':
      return 'knowledge'
    case 'settings':
      return 'settings'
    case 'account':
      return 'account'
    default:
      return null // activity, quality, eval — expanded rail, no second column
  }
}

export type AgentSectionId =
  | 'chat'
  | 'profile'
  | 'directives'
  | 'routines'
  | 'skills'
  | 'context-variables'
  | 'web-chat'
  | 'api-channel'
  | 'mcp-channel'
  | 'slack-channel'
  | 'whatsapp-channel'
  | 'danger'

type AgentSectionRoute = { agentTab: AgentTab; anchor?: string }

const AGENT_SECTION_ROUTES: Record<AgentSectionId, AgentSectionRoute> = {
  chat: { agentTab: 'chat' },
  profile: { agentTab: 'behavior', anchor: 'assistant-profile' },
  directives: { agentTab: 'behavior', anchor: 'assistant-directives' },
  routines: { agentTab: 'behavior', anchor: 'assistant-routines' },
  skills: { agentTab: 'behavior', anchor: 'assistant-skills' },
  'context-variables': { agentTab: 'behavior', anchor: 'assistant-context-variables' },
  'web-chat': { agentTab: 'channels', anchor: 'web-chat' },
  'api-channel': { agentTab: 'channels', anchor: 'api-channel' },
  'mcp-channel': { agentTab: 'channels', anchor: 'mcp-channel' },
  'slack-channel': { agentTab: 'channels', anchor: 'slack-channel' },
  'whatsapp-channel': { agentTab: 'channels', anchor: 'whatsapp-channel' },
  danger: { agentTab: 'behavior', anchor: 'agent-danger-zone' },
}

const ASSISTANT_ANCHORS: Record<string, AgentSectionId> = {
  'assistant-profile': 'profile',
  // The agent's name and its answering behavior are one page, so both anchors
  // resolve to the page that configures them together.
  'assistant-identity': 'profile',
  'assistant-behavior': 'profile',
  'assistant-directives': 'directives',
  'assistant-routines': 'routines',
  'assistant-skills': 'skills',
  'assistant-context-variables': 'context-variables',
  'agent-danger-zone': 'danger',
}

const CHANNEL_ANCHORS: Record<string, AgentSectionId> = {
  'web-chat': 'web-chat',
  // The public link and the website widget are two placements of one chat surface,
  // so both anchors resolve to the page that configures them together.
  'public-chat-link': 'web-chat',
  'website-embed': 'web-chat',
  'api-channel': 'api-channel',
  'mcp-channel': 'mcp-channel',
  'slack-channel': 'slack-channel',
  'whatsapp-channel': 'whatsapp-channel',
}

export const agentSectionRoute = (section: AgentSectionId): AgentSectionRoute => AGENT_SECTION_ROUTES[section]

/** Derive which agent section a route points at, applying each tab's default. */
export function agentSectionFromRoute(routeState: Pick<DashboardRouteState, 'agentTab' | 'anchor' | 'agentRoutineId'>): AgentSectionId {
  if (routeState.agentRoutineId) {
    return 'routines'
  }

  const tab = routeState.agentTab ?? 'chat'
  const anchor = routeState.anchor

  if (tab === 'chat') {
    return 'chat'
  }
  if (tab === 'channels') {
    return (anchor && CHANNEL_ANCHORS[anchor]) || 'web-chat'
  }
  return (anchor && ASSISTANT_ANCHORS[anchor]) || 'profile'
}
