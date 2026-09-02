'use client'

import { useMemo } from 'react'
import { Code2, ExternalLink, FileCode } from 'lucide-react'

import { AgentChannelCredentialManager } from '@/components/dashboard/settings/agent-channel-credential-manager'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { CodeSnippet } from '@/components/shared/api-snippets'
import { CopyValueField } from '@/components/ui/copy-value-field'
import { Label } from '@/components/ui/label'

const API_BASE_PATH = process.env.NEXT_PUBLIC_API_BASE_PATH ?? '/backend/api/v1'
const DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL ?? 'http://localhost:3001'
const PLACEHOLDER_ORIGIN = 'https://your-radioso-host'

const buildAgentChatCurl = (origin: string, agentId: string) => `curl ${origin}${API_BASE_PATH}/agents/${agentId}/chat \\
  -X POST \\
  -H "Authorization: Bearer $RADIOSO_AGENT_API_CREDENTIAL" \\
  -H "Content-Type: application/json" \\
  -d '{"message":"How can you help me?","stream":false}'`

export function ApiChannelCard({ agentId }: { agentId: string }) {
  const origin = useMemo(
    () => (typeof window === 'undefined' ? PLACEHOLDER_ORIGIN : window.location.origin),
    [],
  )
  const apiBaseUrl = `${origin}${API_BASE_PATH}`

  const chatEndpoint = `${apiBaseUrl}/agents/${agentId}/chat`

  return (
    <SettingsCard
      id="api-channel"
      icon={<Code2 className="h-5 w-5 text-primary" />}
      title="Agent API"
      description="Chat with this agent from server-side code or scripts through an agent-bound credential."
    >
      <div className="space-y-5">
        <div className="space-y-2">
          <Label className="text-foreground">Agent chat endpoint</Label>
          <CopyValueField value={chatEndpoint} ariaLabel="Copy Agent API chat endpoint" className="w-full" />
        </div>

        <AgentChannelCredentialManager key={`${agentId}:rest`} agentId={agentId} audience="rest" />

        <div className="space-y-3 rounded-xl bg-muted/50 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 text-foreground">
              <FileCode className="h-4 w-4" />
              <Label className="text-foreground">Quick start</Label>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Start a chat turn through the explicit agent endpoint.
          </p>
          <CodeSnippet label="Chat with this agent" code={buildAgentChatCurl(origin, agentId)} />
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
