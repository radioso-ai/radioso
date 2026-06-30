'use client'

import Link from 'next/link'
import {
  Bot,
  ChevronDown,
  Globe,
  KeyRound,
  Link as LinkIcon,
  MessageCircle,
  MessageSquare,
  Plug,
  Braces,
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
import { SectionNavBody, SubNavRow, type SubNavGroup } from '@/components/dashboard/subnav-column'

/** Status dots only apply to channels that have a clear on/off toggle. */
export type ChannelStatus = Partial<Record<AgentSectionId, boolean>>

type AgentItem = { id: AgentSectionId; label: string; icon: LucideIcon }

type AgentGroup = { label: string | null; items: AgentItem[]; collapsible?: boolean; defaultOpen?: boolean }

const AGENT_GROUPS: AgentGroup[] = [
  { label: null, items: [{ id: 'chat', label: 'Chat', icon: MessageSquare }] },
  {
    label: 'Assistant',
    collapsible: true,
    defaultOpen: true,
    items: [
      { id: 'identity', label: 'Identity & appearance', icon: UserRound },
      { id: 'behavior', label: 'Behavior', icon: SlidersHorizontal },
      { id: 'directives', label: 'Directives', icon: ScrollText },
      { id: 'routines', label: 'Routines', icon: Route },
      { id: 'skills', label: 'Skills', icon: Wrench },
      { id: 'context-variables', label: 'Context', icon: Braces },
    ],
  },
  {
    // One-time setup — collapsed by default, auto-opens when a channel is active.
    label: 'Channels',
    collapsible: true,
    defaultOpen: false,
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
  channelStatus,
}: {
  activeSection: AgentSectionId
  hrefFor: (section: AgentSectionId) => string
  channelStatus?: ChannelStatus
}) {
  const groups: SubNavGroup[] = AGENT_GROUPS.map((group) => ({
    label: group.label,
    collapsible: group.collapsible,
    defaultOpen: group.defaultOpen,
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
    <SectionNavBody
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
  agents: { id: string; name: string; internalName?: string }[]
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
        // The agents section's row IS the agent picker — styled like the active nav row
        // (accent background + left bar) so it reads as "you are in Agents", not a box.
        className="relative flex w-full items-center gap-2 rounded-md bg-sidebar-accent px-2 py-2 text-left text-sm font-medium text-sidebar-accent-foreground transition-colors before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-secondary before:content-['']"
      >
        <Bot className="h-4 w-4 shrink-0 text-secondary" />
        <span className="min-w-0 flex-1 truncate">{agentName}</span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open ? (
        <div className="absolute inset-x-0 top-full z-20 mt-1 max-h-80 overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md">
          {agents.map((agent) => {
            const internalLabel = agent.internalName?.trim()
            const primaryLabel = internalLabel || agent.name || 'Agent'
            return (
              <Link
                key={agent.id}
                href={hrefForAgent(agent.id)}
                onClick={() => onSelectAgent(agent.id)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/60"
              >
                <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{primaryLabel}</span>
                  {/* Show the visitor-facing name underneath when an internal label is overriding it. */}
                  {internalLabel ? (
                    <span className="truncate text-xs text-muted-foreground">{agent.name || 'Agent'}</span>
                  ) : null}
                </span>
              </Link>
            )
          })}
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
