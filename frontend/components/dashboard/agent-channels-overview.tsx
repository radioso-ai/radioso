'use client'

import Link from 'next/link'
import { Globe, KeyRound, Mail, MessageCircle, Wrench, type LucideIcon } from 'lucide-react'

import { SettingsRow, SettingsRowList } from '@/components/dashboard/settings/settings-row-list'
import { LogoSpinner } from '@/components/ui/spinner'
import { Button } from '@/components/ui/button'
import { groupAgentChannels, type AgentChannelCatalogEntry, type AgentChannelCatalogId } from '@/lib/agent-channel-catalog'
import { useAgentChannelCatalog } from '@/lib/use-agent-channel-catalog'
import { useWorkspace } from '@/lib/workspace-context'

const CHANNEL_PRESENTATION: Record<AgentChannelCatalogId, { title: string; icon: LucideIcon; description: string }> = {
  'web-chat': { title: 'Web chat', icon: Globe, description: 'A shareable link and a website widget, sharing one look and wording.' },
  'api-channel': { title: 'Agent API', icon: KeyRound, description: 'Programmatic access for SDK clients and integrations.' },
  'mcp-channel': { title: 'MCP', icon: Wrench, description: 'Connect Model Context Protocol clients to this agent.' },
  'slack-channel': { title: 'Slack', icon: MessageCircle, description: 'Reply to Slack DMs with this agent.' },
  'whatsapp-channel': { title: 'WhatsApp', icon: MessageCircle, description: 'Answer messages sent to the workspace WhatsApp number.' },
  'email-channel': { title: 'Email', icon: Mail, description: 'Answer mail sent to your own support address.' },
}

/** One WhatsApp number serves the whole workspace, so the row says which agent answers it. */
const channelDescription = (entry: AgentChannelCatalogEntry, answeringAgentName: string | null): string => {
  const base = CHANNEL_PRESENTATION[entry.id].description
  if (!entry.workspaceConnection) return base
  if (entry.workspaceConnection.answeredBy === 'this-agent') return 'Shared across the workspace. This agent answers it.'
  return answeringAgentName ? `Shared across the workspace. Answered by ${answeringAgentName}.` : 'Shared across the workspace. Another agent answers it.'
}

const actionLabel = (entry: AgentChannelCatalogEntry): string => {
  if (entry.workspaceConnection?.answeredBy === 'another-agent') return 'View'
  return entry.status === 'needs-setup' ? 'Fix' : entry.status === 'on' ? 'Manage' : 'Set up'
}

function ChannelRow({
  entry,
  href,
  answeringAgentName,
}: {
  entry: AgentChannelCatalogEntry
  href: string
  answeringAgentName: string | null
}) {
  const { title, icon: Icon } = CHANNEL_PRESENTATION[entry.id]
  const label = actionLabel(entry)
  return (
    <SettingsRow
      icon={<Icon className="h-5 w-5 text-primary" />}
      title={title}
      description={channelDescription(entry, answeringAgentName)}
      status={entry.status === 'on' ? { label: 'On', tone: 'active' } : entry.status === 'needs-setup' ? { label: 'Needs setup', tone: 'warning' } : undefined}
      action={
        <Button asChild size="sm" variant={entry.status === 'needs-setup' ? 'default' : 'outline'}>
          <Link href={href} aria-label={`${label} ${title}`}>{label}</Link>
        </Button>
      }
    />
  )
}

function ChannelGroup({
  heading,
  entries,
  hrefForChannel,
  answeringAgentName,
}: {
  heading: string
  entries: AgentChannelCatalogEntry[]
  hrefForChannel: (channelId: AgentChannelCatalogId) => string
  answeringAgentName: string | null
}) {
  if (entries.length === 0) return null
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium text-muted-foreground">{heading} · {entries.length}</h2>
      <SettingsRowList>
        {entries.map((entry) => (
          <ChannelRow key={entry.id} entry={entry} href={hrefForChannel(entry.id)} answeringAgentName={answeringAgentName} />
        ))}
      </SettingsRowList>
    </section>
  )
}

/** Every channel the deployment offers this agent, grouped by what needs doing: fix, manage, or set up. */
export function AgentChannelsOverview({
  agentId,
  hrefForChannel,
}: {
  agentId: string
  hrefForChannel: (channelId: AgentChannelCatalogId) => string
}) {
  const { activeWorkspaceId } = useWorkspace()
  const { entries, whatsappAnsweringAgentName } = useAgentChannelCatalog({ workspaceId: activeWorkspaceId, agentId })

  if (!entries) {
    return (
      <section className="flex min-h-[320px] items-center justify-center">
        <LogoSpinner imageClassName="h-7 w-7" />
      </section>
    )
  }

  const groups = groupAgentChannels(entries)
  return (
    <section className="space-y-6">
      <ChannelGroup heading="Needs setup" entries={groups.needsSetup} hrefForChannel={hrefForChannel} answeringAgentName={whatsappAnsweringAgentName} />
      <ChannelGroup heading="On" entries={groups.on} hrefForChannel={hrefForChannel} answeringAgentName={whatsappAnsweringAgentName} />
      <ChannelGroup heading="Not set up" entries={groups.notSetUp} hrefForChannel={hrefForChannel} answeringAgentName={whatsappAnsweringAgentName} />
    </section>
  )
}
