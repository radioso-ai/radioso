'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { ExternalLink, Plug } from 'lucide-react'

import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { CodeSnippet, useInlineWorkspaceToken } from '@/components/shared/api-snippets'
import { Badge } from '@/components/ui/badge'
import { CopyValueField } from '@/components/ui/copy-value-field'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'

export const MCP_URL = process.env.NEXT_PUBLIC_MCP_URL ?? ''
const DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL ?? 'http://localhost:3001'

const subscribeBrowserOrigin = () => () => {}
const getBrowserOrigin = () => (typeof window === 'undefined' ? '' : window.location.origin)
const getServerOrigin = () => ''

export const buildClientConfig = (mcpUrl: string, authorizationPlaceholder: string) => `{
  "mcpServers": {
    "radioso": {
      "url": "${mcpUrl}",
      "headers": {
        "Authorization": "Bearer ${authorizationPlaceholder}"
      }
    }
  }
}`

export type McpChannelSetupMode = 'same-host' | 'remote' | 'disabled'

export interface McpChannelSetup {
  authorizationPlaceholder: string
  error?: string
  label: string
  mcpUrl: string
  mode: McpChannelSetupMode
  remediation?: string
  steps: string[]
}

export const resolveMcpChannelSetup = ({
  dashboardOrigin,
  mcpUrl,
}: {
  dashboardOrigin: string
  mcpUrl: string
}): McpChannelSetup => {
  const trimmedUrl = mcpUrl.trim()
  if (!trimmedUrl) {
    return {
      authorizationPlaceholder: '<workspace API token>',
      error: 'MCP is not enabled on this deployment.',
      label: 'MCP not enabled',
      mcpUrl: '',
      mode: 'disabled',
      remediation: 'Enable backend MCP with RADIOSO_MCP_ENABLED=true or set NEXT_PUBLIC_MCP_URL to a reachable MCP server URL, then restart Radioso.',
      steps: [],
    }
  }

  let resolvedUrl: URL
  try {
    resolvedUrl = new URL(trimmedUrl, dashboardOrigin || 'http://localhost')
  } catch {
    return {
      authorizationPlaceholder: '<workspace API token>',
      error: 'The configured MCP URL is invalid.',
      label: 'MCP not enabled',
      mcpUrl: trimmedUrl,
      mode: 'disabled',
      remediation: 'Set NEXT_PUBLIC_MCP_URL to an absolute MCP server URL or a root-relative same-host MCP path.',
      steps: [],
    }
  }
  const isRootRelativeUrl = trimmedUrl.startsWith('/')
  const sameHost = isRootRelativeUrl || resolvedUrl.origin === dashboardOrigin

  if (sameHost) {
    return {
      authorizationPlaceholder: '<workspace API token>',
      label: 'Same-host setup',
      mcpUrl: dashboardOrigin ? resolvedUrl.toString() : trimmedUrl,
      mode: 'same-host',
      steps: [
        "Open your AI client's MCP settings.",
        'Paste the MCP server URL.',
        'Paste your workspace API token directly.',
      ],
    }
  }

  return {
    authorizationPlaceholder: '<MCP access token>',
    label: 'Remote setup',
    mcpUrl: resolvedUrl.toString(),
    mode: 'remote',
    steps: [
      "Open your AI client's MCP settings (Cursor, Claude Desktop, or compatible).",
      'Exchange your workspace API token for a short-lived access token. The setup guide shows the one-line command.',
      'Paste the config below, replacing the placeholder with your access token.',
    ],
  }
}

export const shouldProbeMcpHealth = (setup: McpChannelSetup): boolean => setup.mode === 'same-host'

export const useMcpChannelSetup = () => {
  const dashboardOrigin = useSyncExternalStore(subscribeBrowserOrigin, getBrowserOrigin, getServerOrigin)
  const [runtimeMcpUrl, setRuntimeMcpUrl] = useState(MCP_URL)
  const [runtimeMcpError, setRuntimeMcpError] = useState<string | undefined>()

  useEffect(() => {
    const controller = new AbortController()
    const configuredSetup = resolveMcpChannelSetup({
      dashboardOrigin: window.location.origin,
      mcpUrl: MCP_URL || '/backend/mcp',
    })
    if (MCP_URL && !shouldProbeMcpHealth(configuredSetup)) {
      return () => controller.abort()
    }

    void fetch('/backend/health', {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          setRuntimeMcpError('The Radioso backend health endpoint is unavailable.')
          return null
        }
        return response.json()
      })
      .then((body: unknown) => {
        const mcp = body && typeof body === 'object' && 'mcp' in body ? body.mcp : null
        if (!mcp || typeof mcp !== 'object') {
          return
        }
        const enabled = 'enabled' in mcp && mcp.enabled === true
        const standalone = 'standalone' in mcp && mcp.standalone === true
        const path = 'path' in mcp && typeof mcp.path === 'string' ? mcp.path : '/mcp'
        if (enabled && !standalone) {
          setRuntimeMcpUrl(`/backend${path.startsWith('/') ? path : `/${path}`}`)
          return
        }
        if (!MCP_URL) {
          setRuntimeMcpError('MCP is not enabled on this deployment.')
        }
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') {
          return
        }
        setRuntimeMcpError('The Radioso backend health endpoint is unavailable.')
      })

    return () => controller.abort()
  }, [])

  const setup = resolveMcpChannelSetup({ dashboardOrigin, mcpUrl: runtimeMcpUrl })
  const resolvedSetup = runtimeMcpError
    ? {
        ...setup,
        error: runtimeMcpError,
        label: 'MCP unavailable',
        mode: 'disabled' as const,
        remediation: 'Check that backend health is reachable and that RADIOSO_MCP_ENABLED, RADIOSO_MCP_STANDALONE, and RADIOSO_MCP_MOUNT_PATH match the deployment.',
        steps: [],
      }
    : setup

  return resolvedSetup
}

export function McpChannelCard({ workspaceId }: { workspaceId: string | null | undefined }) {
  const { apiToken, apiTokenError, isApiTokenLoading } = useInlineWorkspaceToken(workspaceId)
  const resolvedSetup = useMcpChannelSetup()

  return (
    <SettingsCard
      id="mcp-channel"
      icon={<Plug className="h-5 w-5 text-primary" />}
      title="MCP"
      description="Let AI tools like Cursor, Claude Desktop, or ChatGPT talk to this agent and search its grounded data."
    >
      <div className="space-y-5">
        <p className="text-sm text-muted-foreground">
          MCP (Model Context Protocol) is an open standard. Compatible AI clients can talk to this agent through its
          full turn loop — persona, directives, and routines included — or query its documents directly, through a
          single connection with no custom integration code on your side.
        </p>

        <div className="flex items-center">
          <Badge variant={resolvedSetup.mode === 'disabled' ? 'secondary' : 'outline'}>{resolvedSetup.label}</Badge>
        </div>

        {resolvedSetup.error ? (
          <div className="space-y-1 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            <p>{resolvedSetup.error}</p>
            {resolvedSetup.remediation ? <p>{resolvedSetup.remediation}</p> : null}
          </div>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label className="text-foreground">MCP server</Label>
            <CopyValueField value={resolvedSetup.mcpUrl} ariaLabel="Copy MCP server URL" className="w-full" />
          </div>
          <div className="space-y-2">
            <Label className="text-foreground">Workspace API token</Label>
            {isApiTokenLoading ? (
              <div className="flex h-10 items-center gap-2 text-sm text-muted-foreground">
                <Spinner className="h-4 w-4" />
                Loading workspace API token...
              </div>
            ) : apiTokenError ? (
              <p className="text-sm text-destructive">{apiTokenError}</p>
            ) : apiToken ? (
              <CopyValueField value={apiToken} ariaLabel="Copy workspace API token" className="w-full" truncate />
            ) : null}
          </div>
        </div>

        <div className="space-y-3 rounded-xl bg-muted/50 p-4">
          <div className="flex items-center gap-2 text-foreground">
            <Plug className="h-4 w-4" />
            <Label className="text-foreground">Connect your client</Label>
          </div>
          <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
            {resolvedSetup.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {resolvedSetup.mode !== 'disabled' ? (
            <CodeSnippet
              label="MCP client config"
              code={buildClientConfig(resolvedSetup.mcpUrl, resolvedSetup.authorizationPlaceholder)}
            />
          ) : null}
          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            <a
              href={`${DOCS_URL}/guides/mcp`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              View MCP setup guide
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>
      </div>
    </SettingsCard>
  )
}
