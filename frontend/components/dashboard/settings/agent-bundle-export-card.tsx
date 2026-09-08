'use client'

import { Download, PackageCheck } from 'lucide-react'
import { useState } from 'react'

import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { Button } from '@/components/ui/button'
import { agentBundleApi, agentBundleFileName } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'

/**
 * Downloads the agent as a file. The bundle is fetched and written to disk in one
 * action rather than opened in a tab: it is a document the operator moves, not a
 * page they read.
 */
export function AgentBundleExportCard({
  agentId,
  agentName,
}: {
  agentId: string
  agentName: string
}) {
  const [isExporting, setIsExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exportedFileName, setExportedFileName] = useState<string | null>(null)

  const handleExport = async () => {
    setIsExporting(true)
    setError(null)
    try {
      const bundle = await agentBundleApi.exportBundle(agentId)
      const fileName = agentBundleFileName(agentName, new Date())
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = fileName
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      setExportedFileName(fileName)
    } catch (caught) {
      setError(getApiErrorMessage(caught, 'The agent could not be exported.'))
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <SettingsCard
      id="agent-bundle"
      icon={<PackageCheck className="h-5 w-5 text-primary" />}
      title="Move this agent"
      description="Export the agent as a file, then import it into another workspace."
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Export a bundle</p>
          <p className="text-sm text-muted-foreground">
            Settings, directives, published routines, context variables, and skills. Credentials and
            access tokens stay in this workspace.
          </p>
          {exportedFileName ? (
            <p className="mt-2 text-sm text-muted-foreground" data-testid="agent-bundle-export-result">
              Downloaded <span className="font-medium text-foreground">{exportedFileName}</span>
            </p>
          ) : null}
          {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="sm:self-start"
          onClick={handleExport}
          disabled={isExporting}
          data-testid="agent-bundle-export-button"
        >
          <Download className="mr-2 h-4 w-4" />
          {isExporting ? 'Exporting…' : 'Export bundle'}
        </Button>
      </div>
    </SettingsCard>
  )
}
