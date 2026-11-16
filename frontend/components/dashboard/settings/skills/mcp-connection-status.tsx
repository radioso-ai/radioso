import type { McpConnection } from '@/lib/api-external-skills'
import { cn } from '@/lib/utils'

// What an operator can do to one connection. Each action locks its own connection's controls
// (`useScopedRowMutations` keys), so a request on one connection never frees or blocks another's.
export const CONNECTION_ACTIONS = ['test', 'authorize', 'replace-token', 'delete'] as const
export type McpConnectionAction = (typeof CONNECTION_ACTIONS)[number]

export type McpConnectionTestResult =
  | { status: 'success'; toolCount: number }
  | { status: 'error'; message: string }

export const connectionActionKey = (action: McpConnectionAction, connectionId: string): string =>
  `${action}:${connectionId}`

export const connectionRowDomId = (connectionId: string): string => `mcp-connection-row-${connectionId}`

// An authorized connection is the quiet default; anything else is worth a badge on its row.
export const connectionNeedsAttention = (status: string): boolean => status !== 'authorized'

const statusTone = (status: string) => {
  if (status === 'authorized') return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
  if (status === 'needs_reauth' || status === 'error') return 'bg-destructive/10 text-destructive'
  return 'bg-muted text-muted-foreground'
}

const statusLabel = (status: string) => {
  if (status === 'authorized') return 'Credentials saved'
  if (status === 'needs_reauth') return 'Needs re-auth'
  if (status === 'error') return 'Error'
  if (status === 'unconfigured') return 'Not verified'
  return status
}

export function McpStatusBadge({ status }: { status: string }) {
  return (
    <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-xs font-medium', statusTone(status))}>
      {statusLabel(status)}
    </span>
  )
}

// Null while an older backend revision is still serving and does not report usage.
export const describeConnectionUsage = (usedByAgents: McpConnection['usedByAgents']): string | null => {
  if (!usedByAgents) return null
  return usedByAgents.length > 0 ? usedByAgents.map((agent) => agent.name).join(', ') : 'No skills yet'
}
