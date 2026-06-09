'use client'

import { AssistantMessageContent } from '@/components/dashboard/chat-citations'
import type { ChatConversationTurn } from '@/lib/api'
import type { WorkbenchRunCard } from './use-workbench-state'

function AnswerPane({
  title,
  answer,
  turn,
  run,
  onOpenDocument,
}: {
  title: string
  answer: string
  turn?: ChatConversationTurn | null
  run?: WorkbenchRunCard | null
  onOpenDocument: (documentId: string) => void
}) {
  return (
    <section className="min-w-0 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <p className="text-xs text-muted-foreground">
          {turn?.createdAt ? new Date(turn.createdAt).toLocaleString() : run?.completedAt ? new Date(run.completedAt).toLocaleString() : 'Not run'}
        </p>
      </div>
      <div className="min-h-48 rounded-lg border border-border bg-card p-4">
        {answer ? (
          <AssistantMessageContent
            content={answer}
            citations={run?.citations ?? turn?.citations}
            answerSegments={run?.answerSegments ?? turn?.answerSegments}
            onOpenDocument={async (documentId) => {
              onOpenDocument(documentId)
              return 'opened'
            }}
          />
        ) : (
          <p className="text-sm text-muted-foreground">No answer available.</p>
        )}
      </div>
    </section>
  )
}

export function WorkbenchCompare({
  originalTurn,
  latestRun,
  onOpenDocument,
}: {
  originalTurn: ChatConversationTurn | null
  latestRun: WorkbenchRunCard | null
  onOpenDocument: (documentId: string) => void
}) {
  return (
    <section data-testid="workbench-compare" className="grid min-h-0 gap-4 xl:grid-cols-2">
      <AnswerPane
        title="Original"
        answer={originalTurn?.content ?? ''}
        turn={originalTurn}
        onOpenDocument={onOpenDocument}
      />
      <AnswerPane
        title="Replay"
        answer={latestRun?.answer ?? ''}
        run={latestRun}
        onOpenDocument={onOpenDocument}
      />
    </section>
  )
}
