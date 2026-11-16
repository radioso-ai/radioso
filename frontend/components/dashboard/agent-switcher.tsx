'use client'

import Link from 'next/link'
import { useState } from 'react'
import { Check, ChevronsUpDown, FileJson, PackageCheck, Pencil, Plus, Trash2 } from 'lucide-react'

import { AgentRenameDialog } from '@/components/dashboard/agent-rename-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { downloadAgentBundle } from '@/lib/agent-bundle-download'
import { useAgents } from '@/lib/agents-context'
import { getAgentOperatorLabel } from '@/lib/agent-label'
import type { AgentSettings } from '@/lib/api'
import { agentToGeneralSettings } from '@/lib/api-types'
import { getApiErrorMessage } from '@/lib/api-error'

const initials = (name: string) => name.trim().split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase() || 'A'

function AgentAvatar({ agent, label, size }: { agent: AgentSettings | null; label: string; size: 'md' | 'sm' }) {
  const logoUrl = agent ? agentToGeneralSettings(agent).assistantLogoUrl : null
  return (
    <span
      aria-hidden="true"
      className={size === 'md'
        ? 'flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-md bg-primary/15 text-[10px] font-semibold text-primary'
        : 'flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded bg-sidebar-accent text-[9px] font-semibold'}
      style={logoUrl ? { backgroundImage: `url(${logoUrl})`, backgroundPosition: 'center', backgroundSize: 'cover' } : undefined}
    >
      {logoUrl ? null : initials(label)}
    </span>
  )
}

/**
 * The agent menu's head: names the current agent and opens one menu for everything about agents as
 * a whole. It holds the workspace's agents, then the current agent's admin actions, then the ways to
 * add one. It navigates only through the links it is given and acts only through the callbacks it is given.
 */
export function AgentSwitcher({
  hrefForAgent,
  onNewAgent,
  onImportBundle,
  onDeleteAgent,
}: {
  hrefForAgent: (agentId: string) => string
  onNewAgent: () => void
  onImportBundle: () => void
  onDeleteAgent: (agentId: string) => void
}) {
  const { agents, selectedAgent } = useAgents()
  const [renameOpen, setRenameOpen] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const selectedLabel = selectedAgent ? getAgentOperatorLabel(selectedAgent) : 'Select an agent'

  const exportBundle = async (agent: AgentSettings) => {
    setExportError(null)
    try {
      await downloadAgentBundle(agent.id, getAgentOperatorLabel(agent))
    } catch (caught) {
      setExportError(getApiErrorMessage(caught, 'The agent could not be exported.'))
    }
  }

  return (
    <div className="space-y-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md border border-sidebar-border bg-sidebar px-2 py-1.5 text-left text-sm font-medium text-sidebar-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-sidebar-accent"
          >
            <AgentAvatar agent={selectedAgent} label={selectedLabel} size="md" />
            <span className="min-w-0 flex-1 truncate">{selectedLabel}</span>
            <ChevronsUpDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          {agents.length > 0 ? (
            <>
              <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">Agents in this workspace</DropdownMenuLabel>
              <div className="max-h-52 overflow-y-auto">
                {agents.map((agent) => {
                  const label = getAgentOperatorLabel(agent)
                  const current = agent.id === selectedAgent?.id
                  return (
                    <DropdownMenuItem key={agent.id} asChild>
                      <Link href={hrefForAgent(agent.id)} aria-current={current ? 'true' : undefined}>
                        <AgentAvatar agent={agent} label={label} size="sm" />
                        <span className="min-w-0 flex-1 truncate">{label}</span>
                        {current ? <Check aria-hidden="true" className="ml-auto h-4 w-4" /> : null}
                      </Link>
                    </DropdownMenuItem>
                  )
                })}
              </div>
              <DropdownMenuSeparator />
            </>
          ) : null}
          {selectedAgent ? (
            <>
              <DropdownMenuLabel className="truncate text-xs font-medium text-muted-foreground">{selectedLabel}</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
                <Pencil aria-hidden="true" />
                Rename…
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void exportBundle(selectedAgent)}>
                <PackageCheck aria-hidden="true" />
                Export bundle
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => onDeleteAgent(selectedAgent.id)}>
                <Trash2 aria-hidden="true" />
                Delete agent…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuItem onSelect={onNewAgent}>
            <Plus aria-hidden="true" />
            New agent
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onImportBundle}>
            <FileJson aria-hidden="true" />
            Import a bundle
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {exportError ? <p role="alert" className="px-2 text-xs text-destructive">{exportError}</p> : null}
      {selectedAgent ? <AgentRenameDialog agent={selectedAgent} open={renameOpen} onOpenChange={setRenameOpen} /> : null}
    </div>
  )
}
