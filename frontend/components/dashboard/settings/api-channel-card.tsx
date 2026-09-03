'use client'

import { Code2, ExternalLink, FileCode } from 'lucide-react'

import { AgentChannelCredentialManager } from '@/components/dashboard/settings/agent-channel-credential-manager'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { CodeSnippet } from '@/components/shared/api-snippets'
import { CopyValueField } from '@/components/ui/copy-value-field'
import { Label } from '@/components/ui/label'
import { useDashboardOrigin, useRuntimeConfig } from '@/hooks/use-runtime-config'
import { buildAgentChatEndpoint, resolveApiBaseUrl } from '@/lib/runtime-config'

const API_BASE_PATH = process.env.NEXT_PUBLIC_API_BASE_PATH ?? '/backend/api/v1'
const DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL ?? 'https://docs.radioso.ai'
const PLACEHOLDER_ORIGIN = 'https://your-radioso-host'

const buildAgentChatCurl = (chatEndpoint: string) => `curl ${chatEndpoint} \\
  -X POST \\
  -H "Authorization: Bearer $RADIOSO_AGENT_API_CREDENTIAL" \\
  -H "Content-Type: application/json" \\
  -d '{"message":"How can you help me?","stream":false}'`

export function ApiChannelCard({ agentId }: { agentId: string }) {
  const dashboardOrigin = useDashboardOrigin()
  const { publicApiUrl } = useRuntimeConfig()

  const apiBaseUrl = resolveApiBaseUrl({
    publicApiUrl,
    dashboardOrigin: dashboardOrigin || PLACEHOLDER_ORIGIN,
    basePath: API_BASE_PATH,
  })
  const chatEndpoint = buildAgentChatEndpoint(apiBaseUrl, agentId)

  return (
    <SettingsCard
      id="api-channel"
      icon={<Code2 className="h-5 w-5 text-primary" />}
      title="Agent API"
      description="Agent-bound credentials; no workspace role."
    >
      <div className="space-y-5">
        <div className="space-y-2">
          <Label className="text-foreground">Agent chat endpoint</Label>
          <CopyValueField value={chatEndpoint} ariaLabel="Copy Agent API chat endpoint" className="w-full" />
        </div>

        <AgentChannelCredentialManager key={`${agentId}:rest`} agentId={agentId} audience="rest" />

        <div className="space-y-3 rounded-xl bg-muted/50 p-4">
          <div className="flex items-center gap-2 text-foreground">
            <FileCode className="h-4 w-4" />
            <Label className="text-foreground">Quick start</Label>
          </div>
          <CodeSnippet label="Chat with this agent" code={buildAgentChatCurl(chatEndpoint)} wrap />
          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            <a
              href={`${DOCS_URL}/api`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              View full API reference
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>
      </div>
    </SettingsCard>
  )
}
