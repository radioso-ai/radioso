'use client'

import { ExternalLink, Plug } from 'lucide-react'

import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { CodeSnippet, useInlineWorkspaceToken } from '@/components/shared/api-snippets'
import { CopyValueField } from '@/components/ui/copy-value-field'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'

const MCP_URL = process.env.NEXT_PUBLIC_MCP_URL ?? 'http://localhost:8787/mcp'
const DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL ?? 'http://localhost:3001'

const buildClientConfig = (mcpUrl: string) => `{
  "mcpServers": {
    "radioso": {
      "url": "${mcpUrl}",
      "headers": {
        "Authorization": "Bearer <MCP access token>"
      }
    }
  }
}`

export function McpChannelCard({ workspaceId }: { workspaceId: string | null | undefined }) {
  const { apiToken, apiTokenError, isApiTokenLoading } = useInlineWorkspaceToken(workspaceId)

  return (
    <SettingsCard
      id="mcp-channel"
      icon={<Plug className="h-5 w-5 text-primary" />}
      title="MCP"
      description="Let AI tools like Cursor, Claude Desktop, or ChatGPT search your documents."
    >
      <div className="space-y-5">
        <p className="text-sm text-muted-foreground">
          MCP (Model Context Protocol) is an open standard. Compatible AI clients can search your documents and
          ask grounded questions through a single connection — no custom integration code on your side.
        </p>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label className="text-foreground">MCP server</Label>
            <CopyValueField value={MCP_URL} ariaLabel="Copy MCP server URL" className="w-full" />
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
            <li>Open your AI client&apos;s MCP settings (Cursor, Claude Desktop, or compatible).</li>
            <li>
              Exchange your workspace API token for a short-lived access token. The setup guide shows the one-line
              command.
            </li>
            <li>Paste the config below, replacing the placeholder with your access token.</li>
          </ol>
          <CodeSnippet label="MCP client config" code={buildClientConfig(MCP_URL)} />
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
