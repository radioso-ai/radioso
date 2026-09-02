'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { ExternalLink, Plug } from 'lucide-react'

import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { AgentChannelCredentialManager } from '@/components/dashboard/settings/agent-channel-credential-manager'
import { Badge } from '@/components/ui/badge'
import { CopyValueField } from '@/components/ui/copy-value-field'
import { Label } from '@/components/ui/label'
import { buildConverseClientConfig } from '@/lib/mcp-converse-client-config'

export const MCP_URL = process.env.NEXT_PUBLIC_MCP_URL ?? ''
const DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL ?? 'https://docs.radioso.ai'

const subscribeBrowserOrigin = () => () => {}
const getBrowserOrigin = () => (typeof window === 'undefined' ? '' : window.location.origin)
const getServerOrigin = () => ''

export type McpChannelSetupMode = 'same-host' | 'remote' | 'disabled'

export interface McpChannelSetup {
  error?: string
  label: string
  mcpUrl: string
  mode: McpChannelSetupMode
  remediation?: string
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
      error: 'MCP is not enabled on this deployment.',
      label: 'MCP not enabled',
      mcpUrl: '',
      mode: 'disabled',
      remediation: 'Enable the standalone MCP deployment or set NEXT_PUBLIC_MCP_URL to a reachable MCP server URL, then restart Radioso.',
    }
  }

  let resolvedUrl: URL
  try {
    resolvedUrl = new URL(trimmedUrl, dashboardOrigin || 'http://localhost')
  } catch {
    return {
      error: 'The configured MCP URL is invalid.',
      label: 'MCP not enabled',
      mcpUrl: trimmedUrl,
      mode: 'disabled',
      remediation: 'Set NEXT_PUBLIC_MCP_URL to an absolute MCP server URL or a root-relative same-host MCP path.',
    }
  }
  const isRootRelativeUrl = trimmedUrl.startsWith('/')
  const sameHost = isRootRelativeUrl || resolvedUrl.origin === dashboardOrigin

  if (sameHost) {
    return {
      error: 'The same-host merged MCP endpoint is unavailable in this release. Use standalone MCP with an agent-bound MCP credential instead.',
      label: 'MCP unavailable',
      mcpUrl: dashboardOrigin ? resolvedUrl.toString() : trimmedUrl,
      mode: 'disabled',
      remediation: 'Run the standalone MCP server at a separate origin, set NEXT_PUBLIC_MCP_URL to that URL, then create an MCP credential below.',
    }
  }

  return {
    label: 'Remote setup',
    mcpUrl: resolvedUrl.toString(),
    mode: 'remote',
  }
}

export const shouldProbeMcpHealth = (setup: McpChannelSetup): boolean => setup.mode === 'same-host'

export const useMcpChannelSetup = () => {
  const dashboardOrigin = useSyncExternalStore(subscribeBrowserOrigin, getBrowserOrigin, getServerOrigin)
  const [runtimeMcpUrl, setRuntimeMcpUrl] = useState(MCP_URL)
  const [runtimeMcpError, setRuntimeMcpError] = useState<string | undefined>()

  useEffect(() => {
    const controller = new AbortController()
    if (MCP_URL) {
      return () => controller.abort()
    }

    void fetch('/runtime-config', {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          setRuntimeMcpError('The Radioso runtime configuration is unavailable.')
          return null
        }
        return response.json()
      })
      .then((body: unknown) => {
        if (body && typeof body === 'object' && 'mcpUrl' in body && typeof body.mcpUrl === 'string') {
          setRuntimeMcpUrl(body.mcpUrl)
        }
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') {
          return
        }
        setRuntimeMcpError('The Radioso runtime configuration is unavailable.')
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
        remediation: 'Check that the dashboard runtime configuration can reach the standalone MCP service.',
        steps: [],
      }
    : setup

  return resolvedSetup
}

export function McpChannelCard({ agentId }: { agentId: string }) {
  const resolvedSetup = useMcpChannelSetup()

  return (
    <SettingsCard
      id="mcp-channel"
      icon={<Plug className="h-5 w-5 text-primary" />}
      title="MCP"
      description="Give MCP clients one chat tool for this agent, with the same persona, directives, skills, and routines as the web chat."
    >
      <div className="space-y-5">
        <p className="text-sm text-muted-foreground">
          MCP (Model Context Protocol) is an open standard. Compatible clients receive one agent chat tool; direct
          workspace retrieval and administrative tools are not exposed by this credential.
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

        <div className="space-y-2">
          <Label className="text-foreground">MCP server</Label>
          <CopyValueField value={resolvedSetup.mcpUrl} ariaLabel="Copy MCP server URL" className="w-full" />
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <a
            href={`${DOCS_URL}/guides/mcp-server`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            View MCP setup guide
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>

        <AgentChannelCredentialManager
          key={`${agentId}:mcp`}
          agentId={agentId}
          audience="mcp"
          secretConfiguration={resolvedSetup.mode === 'remote' ? {
            label: 'MCP client config',
            buildCode: (secret) => buildConverseClientConfig(resolvedSetup.mcpUrl, secret),
          } : undefined}
        />
      </div>
    </SettingsCard>
  )
}
