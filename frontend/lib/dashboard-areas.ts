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
  | 'identity'
  | 'behavior'
  | 'skills'
  | 'directives'
  | 'routines'
  | 'public-chat-link'
  | 'website-embed'
  | 'api-channel'
  | 'mcp-channel'
  | 'whatsapp-channel'
  | 'danger'

type AgentSectionRoute = { agentTab: AgentTab; anchor?: string }

const AGENT_SECTION_ROUTES: Record<AgentSectionId, AgentSectionRoute> = {
  chat: { agentTab: 'chat' },
  identity: { agentTab: 'behavior', anchor: 'assistant-identity' },
  behavior: { agentTab: 'behavior', anchor: 'assistant-behavior' },
  skills: { agentTab: 'behavior', anchor: 'assistant-skills' },
  directives: { agentTab: 'behavior', anchor: 'assistant-directives' },
  routines: { agentTab: 'behavior', anchor: 'assistant-routines' },
  'public-chat-link': { agentTab: 'channels', anchor: 'public-chat-link' },
  'website-embed': { agentTab: 'channels', anchor: 'website-embed' },
  'api-channel': { agentTab: 'channels', anchor: 'api-channel' },
  'mcp-channel': { agentTab: 'channels', anchor: 'mcp-channel' },
  'whatsapp-channel': { agentTab: 'channels', anchor: 'whatsapp-channel' },
  danger: { agentTab: 'behavior', anchor: 'agent-danger-zone' },
}

const CHANNEL_ANCHORS: Record<string, AgentSectionId> = {
  'public-chat-link': 'public-chat-link',
  'website-embed': 'website-embed',
  'api-channel': 'api-channel',
  'mcp-channel': 'mcp-channel',
  'whatsapp-channel': 'whatsapp-channel',
}

export const agentSectionRoute = (section: AgentSectionId): AgentSectionRoute => AGENT_SECTION_ROUTES[section]

/** Derive which agent section a route points at, applying each tab's default. */
export function agentSectionFromRoute(routeState: Pick<DashboardRouteState, 'agentTab' | 'anchor'>): AgentSectionId {
  const tab = routeState.agentTab ?? 'chat'
  const anchor = routeState.anchor

  if (tab === 'chat') {
    return 'chat'
  }
  if (tab === 'channels') {
    return (anchor && CHANNEL_ANCHORS[anchor]) || 'public-chat-link'
  }
  if (anchor === 'assistant-behavior') return 'behavior'
  if (anchor === 'assistant-skills') return 'skills'
  if (anchor === 'assistant-directives') return 'directives'
  if (anchor === 'assistant-routines') return 'routines'
  if (anchor === 'agent-danger-zone') return 'danger'
  return 'identity'
}
