'use client'

import { useState } from 'react'
import { Activity, GitBranch, Loader2 } from 'lucide-react'

import { ActivityTraceDetail } from '@/components/dashboard/activity-trace-detail'
import { ActivityTraceGraph } from '@/components/dashboard/activity-trace-graph'
import { AssistantMessageContent } from '@/components/dashboard/chat-citations'
import { TurnFlowOverlay } from '@/components/dashboard/turn-flow-overlay'
import { Button } from '@/components/ui/button'
import { getPrimaryLeafTrace } from '@/lib/turn-trace'
import type { ChatConversationTurn } from '@/lib/api'
import type { WorkbenchRunCard as WorkbenchRunCardData } from './use-workbench-state'

export function WorkbenchRunCard({
  run,
  conversationMessages = [],
  assistantMessageId,
  onOpenDocument,
}: {
  run: WorkbenchRunCardData
  conversationMessages?: ChatConversationTurn[]
  assistantMessageId?: string
  onOpenDocument: (documentId: string) => void
}) {
  const [selectedStageId, setSelectedStageId] = useState<string | undefined>(
    run.activityTrace?.stages[0]?.stageId,
  )
  const [flowOpen, setFlowOpen] = useState(false)
  const leafTrace = run.turnTrace ? getPrimaryLeafTrace(run.turnTrace) : undefined
  const legacyTrace = run.activityTrace ?? leafTrace
  const canOpenFlow = Boolean(run.turnTrace)

  return (
    <article className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Replay run</h3>
          <p className="text-xs text-muted-foreground">
            {run.status} · {run.completedAt ? new Date(run.completedAt).toLocaleString() : 'running'}
          </p>
        </div>
        {canOpenFlow ? (
          <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => setFlowOpen(true)}>
            <GitBranch className="h-3.5 w-3.5" />
            Flow
          </Button>
        ) : null}
      </div>

      <div className="rounded-md border border-border bg-background p-3">
        {run.answer ? (
          <AssistantMessageContent
            content={run.answer}
            citations={run.citations}
            answerSegments={run.answerSegments}
            onOpenDocument={async (documentId) => {
              onOpenDocument(documentId)
              return 'opened'
            }}
          />
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Replay has not produced an answer yet.
          </div>
        )}
      </div>

      {/* TODO(eval-promotion): add promote-to-eval affordance once slice C owns the eval handoff. */}
      {run.turnTrace ? (
        <p className="text-xs text-muted-foreground">
          Open Flow to inspect the replay turn graph.
        </p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-[minmax(180px,260px)_1fr]">
          <div className="rounded-lg border border-border/50 bg-muted/20 p-2">
            {legacyTrace ? (
              <ActivityTraceGraph
                activityTrace={legacyTrace}
                selectedStageId={selectedStageId ?? legacyTrace.stages[0]?.stageId ?? ''}
                onSelectStage={setSelectedStageId}
              />
            ) : (
              <div className="flex items-center gap-2 rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
                <Activity className="h-3.5 w-3.5" />
                Activity trace unavailable.
              </div>
            )}
          </div>
          <ActivityTraceDetail activityTrace={legacyTrace} selectedStageId={selectedStageId} />
        </div>
      )}

      {run.turnTrace ? (
        <TurnFlowOverlay
          open={flowOpen}
          envelope={run.turnTrace}
          leafTrace={leafTrace}
          onClose={() => setFlowOpen(false)}
          messages={conversationMessages}
          assistantMessageId={assistantMessageId}
        />
      ) : null}
    </article>
  )
}
