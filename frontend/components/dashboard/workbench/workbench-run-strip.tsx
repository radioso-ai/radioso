'use client'

import { Play } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { ChatConversationTurn } from '@/lib/api'
import { WorkbenchRunCard } from './workbench-run-card'
import type { WorkbenchRunCard as WorkbenchRunCardData } from './use-workbench-state'

export function WorkbenchRunStrip({
  runs,
  isRunning,
  disabled,
  onRun,
  conversationId,
  conversationMessages,
  assistantMessageId,
  userQueryPreview,
  onOpenDocument,
}: {
  runs: WorkbenchRunCardData[]
  isRunning: boolean
  disabled: boolean
  onRun: () => void
  conversationId?: string
  conversationMessages?: ChatConversationTurn[]
  assistantMessageId?: string
  userQueryPreview?: string
  onOpenDocument: (documentId: string) => void
}) {
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Runs</h2>
          <p className="text-xs text-muted-foreground">Replay uses eval one-off runs with agent config overrides.</p>
        </div>
        <Button type="button" className="gap-1.5" disabled={disabled || isRunning} onClick={onRun}>
          <Play className="h-3.5 w-3.5" />
          {isRunning ? 'Running' : 'Run replay'}
        </Button>
      </div>
      <div className="space-y-4">
        {runs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            No replay runs yet.
          </div>
        ) : (
          runs.map((run) => (
            <WorkbenchRunCard
              key={run.id}
              run={run}
              conversationId={conversationId}
              conversationMessages={conversationMessages}
              assistantMessageId={assistantMessageId}
              userQueryPreview={userQueryPreview}
              onOpenDocument={onOpenDocument}
            />
          ))
        )}
      </div>
    </section>
  )
}
