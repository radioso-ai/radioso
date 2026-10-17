import { CodeSnippet } from '@/components/shared/api-snippets'
import { CopyValueField } from '@/components/ui/copy-value-field'
import { buildAgentMcpConnectDetails } from '@/lib/agent-mcp-connect'
import { MCP_OPEN_ACCESS_CLIENT_SETUPS } from '@/lib/mcp-client-setups'

export function AgentDeveloperConnectBlock({
  dashboardOrigin,
  mcpUrl,
  publicApiUrl,
  publicId,
}: {
  dashboardOrigin: string
  mcpUrl: string
  publicApiUrl: string
  publicId: string
}) {
  const { endpoint, discoveryCardUrl } = buildAgentMcpConnectDetails({
    dashboardOrigin,
    mcpUrl,
    publicApiUrl,
    publicId,
  })

  return (
    <section aria-label="Share with agent developers" className="space-y-4 rounded-xl border border-border bg-muted/30 p-4">
      <div className="space-y-1">
        <h4 className="text-sm font-medium text-foreground">Share with agent developers</h4>
        <p className="text-xs text-muted-foreground">These examples connect through open access. They contain no credential.</p>
      </div>

      <CopyValueField label="Agent endpoint" value={endpoint} ariaLabel="Copy agent endpoint" wrap />
      <CopyValueField label="Discovery card" value={discoveryCardUrl} ariaLabel="Copy discovery card URL" wrap />

      <div className="grid gap-4 xl:grid-cols-2">
        {MCP_OPEN_ACCESS_CLIENT_SETUPS.map((setup) => (
          'buildSteps' in setup
            ? <div key={setup.id} className="space-y-2 rounded-lg border border-border bg-background p-3 text-xs text-muted-foreground">
              <h5 className="font-medium text-foreground">{setup.name} setup</h5>
              <ol className="list-decimal space-y-1 pl-4">
                {setup.buildSteps(endpoint).map((step) => <li key={step}>{step}</li>)}
              </ol>
            </div>
            : <CodeSnippet key={setup.id} label={`${setup.name} configuration`} code={setup.buildSnippet(endpoint)} wrap />
        ))}
      </div>
    </section>
  )
}
