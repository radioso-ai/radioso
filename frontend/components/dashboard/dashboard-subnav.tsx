'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import {
  Bot,
  ChevronDown,
  Globe,
  KeyRound,
  Link as LinkIcon,
  MessageSquare,
  Plug,
  Plus,
  SlidersHorizontal,
  Trash2,
  UserRound,
  Wrench,
  type LucideIcon,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { type AgentTab, type DashboardRouteState } from '@/lib/dashboard-routes'

/**
 * Contextual second-column navigation. Each agent section maps to an existing
 * (agentTab, anchor) route so the sub-nav is a route-driven view of state the
 * router already understands — no new routing concepts. Channel sections reuse
 * the anchors the channels content already keys on.
 */

export type AgentSectionId =
  | 'chat'
  | 'identity'
  | 'behavior'
  | 'skills'
  | 'public-chat-link'
  | 'website-embed'
  | 'api-channel'
  | 'mcp-channel'
  | 'danger'

type AgentSectionRoute = { agentTab: AgentTab; anchor?: string }

const AGENT_SECTION_ROUTES: Record<AgentSectionId, AgentSectionRoute> = {
  chat: { agentTab: 'chat' },
  identity: { agentTab: 'behavior', anchor: 'assistant-identity' },
  behavior: { agentTab: 'behavior', anchor: 'assistant-behavior' },
  skills: { agentTab: 'behavior', anchor: 'assistant-skills' },
  'public-chat-link': { agentTab: 'channels', anchor: 'public-chat-link' },
  'website-embed': { agentTab: 'channels', anchor: 'website-embed' },
  'api-channel': { agentTab: 'channels', anchor: 'api-channel' },
  'mcp-channel': { agentTab: 'channels', anchor: 'mcp-channel' },
  danger: { agentTab: 'behavior', anchor: 'agent-danger-zone' },
}

const CHANNEL_ANCHORS: Record<string, AgentSectionId> = {
  'public-chat-link': 'public-chat-link',
  'website-embed': 'website-embed',
  'api-channel': 'api-channel',
  'mcp-channel': 'mcp-channel',
}

export const agentSectionRoute = (section: AgentSectionId): AgentSectionRoute => AGENT_SECTION_ROUTES[section]

/** Derive which section a route points at, applying each tab's default. */
export function agentSectionFromRoute(routeState: Pick<DashboardRouteState, 'agentTab' | 'anchor'>): AgentSectionId {
  const tab = routeState.agentTab ?? 'chat'
  const anchor = routeState.anchor

  if (tab === 'chat') {
    return 'chat'
  }
  if (tab === 'channels') {
    return (anchor && CHANNEL_ANCHORS[anchor]) || 'public-chat-link'
  }
  // behavior tab
  if (anchor === 'assistant-behavior') return 'behavior'
  if (anchor === 'assistant-skills') return 'skills'
  if (anchor === 'agent-danger-zone') return 'danger'
  return 'identity'
}

type SubNavItem = { id: AgentSectionId; label: string; icon: LucideIcon }
type SubNavGroup = { label: string | null; items: SubNavItem[] }

const AGENT_GROUPS: SubNavGroup[] = [
  { label: null, items: [{ id: 'chat', label: 'Chat', icon: MessageSquare }] },
  {
    label: 'Assistant',
    items: [
      { id: 'identity', label: 'Identity & appearance', icon: UserRound },
      { id: 'behavior', label: 'Behavior', icon: SlidersHorizontal },
      { id: 'skills', label: 'Skills', icon: Wrench },
    ],
  },
  {
    label: 'Channels',
    items: [
      { id: 'public-chat-link', label: 'Public chat link', icon: LinkIcon },
      { id: 'website-embed', label: 'Website widget', icon: Globe },
      { id: 'api-channel', label: 'API', icon: KeyRound },
      { id: 'mcp-channel', label: 'MCP', icon: Plug },
    ],
  },
]

const AGENT_FOOTER: SubNavItem = { id: 'danger', label: 'Danger zone', icon: Trash2 }

/** Status dots only apply to channels that have a clear on/off toggle. */
export type ChannelStatus = Partial<Record<AgentSectionId, boolean>>

/** Shared header-band height so the logo, switcher, and item title line up. */
export const SUBNAV_HEADER = 'flex h-14 shrink-0 items-center'

export function DashboardSubNav({
  activeSection,
  hrefFor,
  switcher,
  channelStatus,
}: {
  activeSection: AgentSectionId
  hrefFor: (section: AgentSectionId) => string
  switcher: ReactNode
  channelStatus?: ChannelStatus
}) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className={cn(SUBNAV_HEADER, 'relative border-b border-sidebar-border px-3')}>{switcher}</div>

      <div className="flex-1 overflow-y-auto p-2">
        {AGENT_GROUPS.map((group, index) => (
          <div key={group.label ?? `group-${index}`} className={cn(index > 0 && 'mt-3')}>
            {group.label ? (
              <p className="px-3 pb-1 pt-1 text-[11px] font-medium uppercase tracking-[0.14em] text-sidebar-foreground/50">
                {group.label}
              </p>
            ) : null}
            <div className="space-y-0.5">
              {group.items.map((item) => (
                <SubNavRow
                  key={item.id}
                  item={item}
                  href={hrefFor(item.id)}
                  active={activeSection === item.id}
                  status={channelStatus?.[item.id]}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-sidebar-border p-2">
        <SubNavRow item={AGENT_FOOTER} href={hrefFor(AGENT_FOOTER.id)} active={activeSection === AGENT_FOOTER.id} danger />
      </div>
    </aside>
  )
}

function SubNavRow({
  item,
  href,
  active,
  status,
  danger,
}: {
  item: SubNavItem
  href: string
  active: boolean
  status?: boolean
  danger?: boolean
}) {
  return (
    <Link
      href={href}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
        active
          ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
          : danger
            ? 'text-destructive/80 hover:bg-destructive/10 hover:text-destructive'
            : 'text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
      )}
    >
      <item.icon
        className={cn(
          'h-4 w-4 shrink-0',
          active ? 'text-secondary' : danger ? 'text-destructive/70' : 'text-sidebar-foreground/60',
        )}
      />
      <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
      {status !== undefined ? (
        <span
          className={cn('h-1.5 w-1.5 shrink-0 rounded-full', status ? 'bg-emerald-500' : 'bg-sidebar-foreground/25')}
          title={status ? 'On' : 'Off'}
        />
      ) : null}
    </Link>
  )
}

export function AgentSwitcher({
  agentName,
  agents,
  open,
  onOpenChange,
  hrefForAgent,
  onSelectAgent,
  onCreateAgent,
}: {
  agentName: string
  agents: { id: string; name: string }[]
  open: boolean
  onOpenChange: (open: boolean) => void
  hrefForAgent: (agentId: string) => string
  onSelectAgent: (agentId: string) => void
  onCreateAgent: () => void
}) {
  return (
    <>
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        className="flex w-full items-center gap-2 rounded-md border border-sidebar-border bg-background px-2.5 py-2 text-left text-sm transition-colors hover:bg-sidebar-accent"
      >
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Bot className="h-4 w-4" />
        </div>
        <span className="min-w-0 flex-1 truncate font-medium">{agentName}</span>
        <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open ? (
        <div className="absolute inset-x-3 top-full z-20 mt-1 max-h-80 overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md">
          {agents.map((agent) => (
            <Link
              key={agent.id}
              href={hrefForAgent(agent.id)}
              onClick={() => onSelectAgent(agent.id)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/60"
            >
              <Bot className="h-4 w-4 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{agent.name || 'Agent'}</span>
            </Link>
          ))}
          <button
            type="button"
            onClick={onCreateAgent}
            className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted/60"
          >
            <Plus className="h-4 w-4" />
            New agent
          </button>
        </div>
      ) : null}
    </>
  )
}
