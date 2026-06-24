'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import {
  Bot,
  ChevronDown,
  Globe,
  KeyRound,
  Link as LinkIcon,
  MessageCircle,
  MessageSquare,
  Plug,
  Plus,
  Route,
  ScrollText,
  SlidersHorizontal,
  Trash2,
  UserRound,
  Wrench,
  type LucideIcon,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { type AgentSectionId } from '@/lib/dashboard-areas'
import { SubNavColumn, SubNavRow, type SubNavGroup } from '@/components/dashboard/subnav-column'

/** Status dots only apply to channels that have a clear on/off toggle. */
export type ChannelStatus = Partial<Record<AgentSectionId, boolean>>

type AgentItem = { id: AgentSectionId; label: string; icon: LucideIcon }

const AGENT_GROUPS: { label: string | null; items: AgentItem[] }[] = [
  { label: null, items: [{ id: 'chat', label: 'Chat', icon: MessageSquare }] },
  {
    label: 'Assistant',
    items: [
      { id: 'identity', label: 'Identity & appearance', icon: UserRound },
      { id: 'behavior', label: 'Behavior', icon: SlidersHorizontal },
      { id: 'directives', label: 'Directives', icon: ScrollText },
      { id: 'routines', label: 'Routines', icon: Route },
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
      { id: 'slack-channel', label: 'Slack', icon: MessageCircle },
      { id: 'whatsapp-channel', label: 'WhatsApp', icon: MessageCircle },
    ],
  },
]

const AGENT_FOOTER: AgentItem = { id: 'danger', label: 'Danger zone', icon: Trash2 }

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
  const groups: SubNavGroup[] = AGENT_GROUPS.map((group) => ({
    label: group.label,
    items: group.items.map((item) => ({
      id: item.id,
      label: item.label,
      icon: item.icon,
      href: hrefFor(item.id),
      active: activeSection === item.id,
      status: channelStatus?.[item.id],
    })),
  }))

  return (
    <SubNavColumn
      header={switcher}
      groups={groups}
      footer={
        <SubNavRow
          entry={{
            id: AGENT_FOOTER.id,
            label: AGENT_FOOTER.label,
            icon: AGENT_FOOTER.icon,
            href: hrefFor(AGENT_FOOTER.id),
            active: activeSection === AGENT_FOOTER.id,
            danger: true,
          }}
        />
      }
    />
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
        <div className="absolute inset-x-4 top-full z-20 mt-1 max-h-80 overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md">
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
