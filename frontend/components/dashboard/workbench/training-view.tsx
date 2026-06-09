'use client'

import { useEffect, useState } from 'react'
import { CheckCircle2, GraduationCap, Lightbulb, WandSparkles } from 'lucide-react'

import { AssistantMessageContent } from '@/components/dashboard/chat-citations'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { directivesApi, type AgentSettings, type ChatConversationTurn, type Directive } from '@/lib/api'
import type { WorkbenchSeedTurn } from './use-workbench-state'
import { useCoachState } from './use-coach-state'

function TranscriptTurn({
  turn,
  selected,
  onOpenDocument,
}: {
  turn: ChatConversationTurn
  selected: boolean
  onOpenDocument: (documentId: string) => void
}) {
  const roleLabel = turn.role === 'assistant' ? 'Assistant' : turn.role === 'user' ? 'Customer' : 'System'
  return (
    <article className={`rounded-lg border p-3 ${selected ? 'border-primary/50 bg-primary/5' : 'border-border bg-card'}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <Badge variant={turn.role === 'assistant' ? 'default' : 'secondary'}>{roleLabel}</Badge>
        <span className="text-xs text-muted-foreground">{new Date(turn.createdAt).toLocaleString()}</span>
      </div>
      {turn.role === 'assistant' ? (
        <AssistantMessageContent
          content={turn.content}
          citations={turn.citations}
          answerSegments={turn.answerSegments}
          onOpenDocument={async (documentId) => {
            onOpenDocument(documentId)
            return 'opened'
          }}
        />
      ) : (
        <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">{turn.content}</p>
      )}
    </article>
  )
}

export function TrainingView({
  selectedAgent,
  seedTurn,
  onOpenDocument,
}: {
  selectedAgent: AgentSettings
  seedTurn: WorkbenchSeedTurn
  onOpenDocument: (documentId: string) => void
}) {
  const [existingDirectives, setExistingDirectives] = useState<Directive[]>([])
  useEffect(() => {
    let cancelled = false
    void directivesApi.listDirectives(selectedAgent.id)
      .then((response) => {
        if (!cancelled) setExistingDirectives(response.directives)
      })
      .catch(() => {
        if (!cancelled) setExistingDirectives([])
      })
    return () => {
      cancelled = true
    }
  }, [selectedAgent.id])

  const coach = useCoachState({ selectedAgent, seedTurn, existingDirectives })
  const [coachingText, setCoachingText] = useState('')
  const previewAnswer = coach.preview?.replay.answer
    ?? coach.preview?.replay.run.observedOutput.answer
    ?? ''
  const diagnosis = coach.preview?.draft.diagnosis

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-3 border-b border-border pb-3">
        <div>
          <div className="flex items-center gap-2">
            <GraduationCap className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">Training</h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Coach this captured answer, preview the next response, then validate it as a directive.</p>
        </div>
        {coach.status === 'done' ? (
          <Badge variant="secondary" className="gap-1">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Validated
          </Badge>
        ) : null}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(320px,0.7fr)]">
        <div className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Transcript</h3>
          {seedTurn.conversation.messages.map((turn) => (
            <TranscriptTurn
              key={turn.id}
              turn={turn}
              selected={turn.id === seedTurn.assistantTurn?.id}
              onOpenDocument={onOpenDocument}
            />
          ))}
        </div>

        <div className="space-y-4">
          <form
            className="space-y-3 rounded-lg border border-border bg-card p-4"
            onSubmit={(event) => {
              event.preventDefault()
              void coach.submitCoaching(coachingText)
            }}
          >
            <label htmlFor="coach-input" className="text-sm font-medium text-foreground">
              Coach your AI agent on how to respond
            </label>
            <Textarea
              id="coach-input"
              value={coachingText}
              onChange={(event) => setCoachingText(event.target.value)}
              placeholder="Explain what the assistant should do differently next time."
              rows={5}
              disabled={coach.status === 'drafting' || coach.status === 'validating'}
            />
            <Button type="submit" className="gap-1.5" disabled={!coach.canSubmit || coach.status === 'drafting'}>
              <WandSparkles className="h-3.5 w-3.5" />
              {coach.status === 'drafting' ? 'Drafting' : 'Draft directive'}
            </Button>
          </form>

          {coach.error ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {coach.error}
            </div>
          ) : null}

          {coach.preview ? (
            <div className="space-y-4 rounded-lg border border-border bg-card p-4">
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-foreground">Drafted directive</h3>
                <div className="space-y-2 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">Name</p>
                    <p className="font-medium text-foreground">{coach.preview.draft.directive.name}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Action</p>
                    <p className="whitespace-pre-wrap text-foreground">{coach.preview.draft.directive.action}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Scope</p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {coach.preview.draft.directive.tags.length > 0 ? (
                        coach.preview.draft.directive.tags.map((tag) => (
                          <Badge key={tag} variant="secondary">{tag}</Badge>
                        ))
                      ) : (
                        <Badge variant="secondary">Global</Badge>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {diagnosis === 'knowledge_recommended_deferred' ? (
                <div className="flex gap-2 rounded-lg border border-amber-300/60 bg-amber-50 p-3 text-sm text-amber-900">
                  <Lightbulb className="mt-0.5 h-4 w-4 shrink-0" />
                  <p>This looks like missing knowledge. Knowledge training is not blocking this directive preview yet.</p>
                </div>
              ) : null}

              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-foreground">Next time I&apos;ll say...</h3>
                <div className="min-h-28 rounded-lg border border-border bg-background p-3">
                  {previewAnswer ? (
                    <AssistantMessageContent
                      content={previewAnswer}
                      citations={coach.preview.replay.citations}
                      answerSegments={coach.preview.replay.answerSegments}
                      onOpenDocument={async (documentId) => {
                        onOpenDocument(documentId)
                        return 'opened'
                      }}
                    />
                  ) : (
                    <p className="text-sm text-muted-foreground">No preview answer returned.</p>
                  )}
                </div>
              </div>

              <Button
                type="button"
                className="gap-1.5"
                disabled={coach.status === 'validating' || coach.status === 'done'}
                onClick={() => {
                  void coach.validate()
                }}
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                {coach.status === 'validating' ? 'Validating' : coach.status === 'done' ? 'Validated' : 'Validate'}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}
