'use client'

import { useState } from 'react'
import { ExternalLink, Plug, Plus } from 'lucide-react'

import { AgentChannelCredentialList } from '@/components/dashboard/settings/agent-channel-credential-manager'
import { CredentialIssuedDialog } from '@/components/dashboard/settings/credential-dialogs'
import { McpConnectClientDialog } from '@/components/dashboard/settings/mcp-connect-client-dialog'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { CodeSnippet } from '@/components/shared/api-snippets'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CopyValueField } from '@/components/ui/copy-value-field'
import { Label } from '@/components/ui/label'
import { useAgentChannelCredentials } from '@/hooks/use-agent-channel-credentials'
import { useDashboardOrigin, useRuntimeConfig } from '@/hooks/use-runtime-config'
import { GENERIC_MCP_CLIENT_ID, getMcpClientSetup, type McpClientSetup } from '@/lib/mcp-client-setups'

const DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL ?? 'https://docs.radioso.ai'
const MCP_GUIDE_URL = `${DOCS_URL}/guides/mcp-server`
const BUILD_TIME_MCP_URL = process.env.NEXT_PUBLIC_MCP_URL ?? ''

const CARD_DESCRIPTION = 'This agent as a chat tool for MCP clients.'

export type McpChannelSetupMode = 'disabled' | 'enabled'

export interface McpChannelSetup {
  mcpUrl: string
  mode: McpChannelSetupMode
}

const DISABLED_SETUP: McpChannelSetup = { mcpUrl: '', mode: 'disabled' }

/**
 * MCP is reachable only as a standalone origin. A missing, unparseable, or dashboard-origin
 * URL all mean the same thing to an operator standing in front of this card: not enabled here.
 */
export const resolveMcpChannelSetup = ({
  dashboardOrigin,
  mcpUrl,
}: {
  dashboardOrigin: string
  mcpUrl: string
}): McpChannelSetup => {
  const trimmedUrl = mcpUrl.trim()
  if (!trimmedUrl) return DISABLED_SETUP

  let resolvedUrl: URL
  try {
    resolvedUrl = new URL(trimmedUrl, dashboardOrigin || 'http://localhost')
  } catch {
    return DISABLED_SETUP
  }

  const sameHost = trimmedUrl.startsWith('/') || resolvedUrl.origin === dashboardOrigin
  if (sameHost) return DISABLED_SETUP

  return { mcpUrl: resolvedUrl.toString(), mode: 'enabled' }
}

export const useMcpChannelSetup = (): McpChannelSetup => {
  const dashboardOrigin = useDashboardOrigin()
  const runtimeConfig = useRuntimeConfig()
  // Once the deployment answers, its value is authoritative — an empty answer means
  // "not enabled here". The build-time default only covers the pre-resolve window
  // and deployments without the runtime-config route.
  return resolveMcpChannelSetup({
    dashboardOrigin,
    mcpUrl: runtimeConfig.isResolved ? runtimeConfig.mcpUrl : (runtimeConfig.mcpUrl || BUILD_TIME_MCP_URL),
  })
}

function McpGuideLink({ children }: { children: string }) {
  return (
    <a
      href={MCP_GUIDE_URL}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
    >
      {children}
      <ExternalLink className="h-3 w-3" />
    </a>
  )
}

function ClientConfigContent({ setup, mcpUrl, secret }: { setup: McpClientSetup; mcpUrl: string; secret: string }) {
  return (
    <div className="space-y-3">
      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        {setup.steps.map((step) => <li key={step}>{step}</li>)}
      </ol>
      <CodeSnippet label={`${setup.name} configuration`} code={setup.buildSnippet(mcpUrl, secret)} />
    </div>
  )
}

function McpConnectedClients({ agentId, mcpUrl }: { agentId: string; mcpUrl: string }) {
  const engine = useAgentChannelCredentials(agentId, 'mcp')
  const [isPickerOpen, setIsPickerOpen] = useState(false)
  // Set while connecting a specific client; a rotation has no recorded client, so it falls back
  // to the generic configuration block.
  const [connectSetup, setConnectSetup] = useState<McpClientSetup | null>(null)

  const connect = async ({ setup, label, expiresAt }: { setup: McpClientSetup; label: string; expiresAt: string }) => {
    setConnectSetup(setup)
    const issued = await engine.issue({ label, expiresAt })
    if (issued) setIsPickerOpen(false)
  }

  const rotate = async (credentialId: string) => {
    setConnectSetup(null)
    return engine.rotate(credentialId)
  }

  const issuedSetup = connectSetup ?? getMcpClientSetup(GENERIC_MCP_CLIENT_ID)

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-muted/40 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">Connect a client</p>
          <p className="text-xs text-muted-foreground">Paste-ready config with its own credential per client.</p>
        </div>
        <Button type="button" size="sm" onClick={() => setIsPickerOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Connect a client
        </Button>
      </div>

      <div className="space-y-2">
        <Label className="text-foreground">MCP server</Label>
        <CopyValueField value={mcpUrl} ariaLabel="Copy MCP server URL" className="w-full" />
      </div>

      {engine.error ? <p role="alert" className="text-sm text-destructive">{engine.error}</p> : null}

      <AgentChannelCredentialList
        heading="Connected clients"
        emptyMessage="No clients connected yet."
        credentials={engine.credentials}
        busyCredentialId={engine.busyCredentialId}
        hasMore={engine.hasMore}
        isLoading={engine.isLoading}
        isLoadingMore={engine.isLoadingMore}
        onLoadMore={() => void engine.loadMore()}
        onRevoke={engine.revoke}
        onRotate={rotate}
      />

      <div className="flex justify-end">
        <McpGuideLink>MCP setup guide</McpGuideLink>
      </div>

      {isPickerOpen ? (
        <McpConnectClientDialog
          error={engine.error}
          isSubmitting={engine.isCreating}
          onOpenChange={(open) => {
            if (!open) setIsPickerOpen(false)
          }}
          onSubmit={(input) => void connect(input)}
        />
      ) : null}

      {engine.issued ? (
        <CredentialIssuedDialog
          secret={engine.issued.secret}
          title={connectSetup ? `Finish connecting — ${connectSetup.name}` : 'Credential issued'}
          acknowledgeLabel={connectSetup ? 'Config pasted — the secret won’t be shown again.' : undefined}
          copyAriaLabel="Copy MCP credential secret"
          additionalContent={<ClientConfigContent setup={issuedSetup} mcpUrl={mcpUrl} secret={engine.issued.secret} />}
          error={engine.error}
          onDiscard={async () => {
            if (engine.issued) await engine.revoke(engine.issued.credential.id)
          }}
          onDone={engine.clearIssued}
        />
      ) : null}
    </div>
  )
}

export function McpChannelCard({ agentId }: { agentId: string }) {
  const setup = useMcpChannelSetup()

  if (setup.mode === 'disabled') {
    return (
      <SettingsCard
        id="mcp-channel"
        icon={<Plug className="h-5 w-5 text-primary" />}
        title="MCP"
        description={CARD_DESCRIPTION}
        headerEnd={<Badge variant="secondary">Not enabled</Badge>}
      >
        <div className="space-y-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          <p>Not enabled on this deployment.</p>
          <McpGuideLink>Deployment setup guide</McpGuideLink>
        </div>
      </SettingsCard>
    )
  }

  return (
    <SettingsCard
      id="mcp-channel"
      icon={<Plug className="h-5 w-5 text-primary" />}
      title="MCP"
      description={CARD_DESCRIPTION}
      headerEnd={<Badge variant="outline">Enabled</Badge>}
    >
      <McpConnectedClients key={`${agentId}:mcp`} agentId={agentId} mcpUrl={setup.mcpUrl} />
    </SettingsCard>
  )
}
