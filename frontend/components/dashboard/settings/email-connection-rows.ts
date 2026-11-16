import type {
  CustomerEmailConnection,
  CustomerEmailOauthProviderId,
  WorkspaceOauthConnection,
} from '@/lib/api'

export const EMAIL_PROVIDERS: Array<{
  id: CustomerEmailOauthProviderId
  label: string
  defaultName: string
  defaultScopes: string[]
}> = [
  {
    id: 'google_mail',
    label: 'Google Gmail',
    defaultName: 'Support Gmail',
    defaultScopes: [
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/gmail.send',
    ],
  },
  {
    id: 'microsoft_graph_mail',
    label: 'Microsoft 365 Outlook',
    defaultName: 'Support Outlook',
    defaultScopes: ['Mail.ReadWrite', 'Mail.Send'],
  },
]

type ConnectionStatus = WorkspaceOauthConnection['status'] | CustomerEmailConnection['status']

export const statusTone = (status: ConnectionStatus) => {
  if (status === 'authorized') return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
  if (status === 'needs_reauth' || status === 'error') return 'bg-destructive/10 text-destructive'
  return 'bg-muted text-muted-foreground'
}

export const statusLabel = (status: ConnectionStatus) => {
  if (status === 'authorized') return 'Authorized'
  if (status === 'needs_reauth') return 'Needs re-auth'
  if (status === 'pending') return 'Pending'
  if (status === 'disabled') return 'Disabled'
  if (status === 'error') return 'Error'
  return status
}

export const providerLabel = (providerId: string) =>
  EMAIL_PROVIDERS.find((provider) => provider.id === providerId)?.label ?? providerId

export const emailConnectionRowDomId = (connectionId: string): string => `email-connection-${connectionId}`

// Active and disabled are the two normal states: one is the switch on, the other the switch off.
// Only a connection that cannot send mail on its own earns a badge on its row.
export const hasEmailConnectionProblem = (status: CustomerEmailConnection['status']): boolean => {
  switch (status) {
    case 'needs_reauth':
    case 'error':
      return true
    case 'authorized':
    case 'disabled':
    case 'unconfigured':
      return false
  }
}

export const emailConnectionSender = (connection: CustomerEmailConnection): string =>
  connection.senderName ? `${connection.senderName} <${connection.senderEmail}>` : connection.senderEmail

export const emailConnectionRowSummary = (connection: CustomerEmailConnection): string =>
  `${emailConnectionSender(connection)} · ${providerLabel(connection.provider)}`

export type EmailConnectionHealth = NonNullable<CustomerEmailConnection['lastHealthStatus']>

export const healthLabel = (health: CustomerEmailConnection['lastHealthStatus']): string => {
  if (health === 'ok') return 'OK'
  if (health === 'failed') return 'Failed'
  if (health === 'unknown') return 'Unknown'
  return 'Not checked'
}

// What a health check just found, said right where the operator ran it.
export const healthCheckResultMessage = (health: EmailConnectionHealth): string => {
  if (health === 'ok') return 'Health check passed.'
  if (health === 'failed') return 'Health check failed.'
  return 'Health check was inconclusive.'
}
