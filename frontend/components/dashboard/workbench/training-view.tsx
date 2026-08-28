'use client'

import { useEffect, useState } from 'react'
import { CheckCircle2, GraduationCap, Lightbulb, WandSparkles } from 'lucide-react'

import { AssistantMessageContent } from '@/components/dashboard/chat-citations'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { directivesApi, type AgentSettings, type Directive } from '@/lib/api'
import { directiveSurfaceLabel } from '@/lib/directive-surfaces'
import type { WorkbenchReplayRunResponse } from '@/lib/api-eval'
import type { WorkbenchSeedTurn } from './use-workbench-state'
import { useCoachState, type CoachStateDeps, type DirectivesLoadStatus } from './use-coach-state'

const directivesLoadErrorMessage = "Couldn't load existing directives - reload before coaching so the preview matches what gets saved."

type DirectivesLoadState = {
  agentId: string
  status: DirectivesLoadStatus
  directives: Directive[]
}

export function TrainingView({
  selectedAgent,
  seedTurn,
  onOpenDocument,
  snapshotId,
  coachDeps,
  onPreviewCreated,
}: {
  selectedAgent: AgentSettings
  seedTurn: WorkbenchSeedTurn
  onOpenDocument: (documentId: string) => void
  snapshotId?: string | null
  coachDeps?: Partial<CoachStateDeps>
  onPreviewCreated?: (preview: WorkbenchReplayRunResponse) => void
}) {
  const [existingDirectives, setExistingDirectives] = useState<DirectivesLoadState>({
    agentId: selectedAgent.id,
    status: 'loading',
    directives: [],
  })
  useEffect(() => {
    let cancelled = false
    void directivesApi.listDirectives(selectedAgent.id)
      .then((response) => {
        if (!cancelled) {
          setExistingDirectives({
            agentId: selectedAgent.id,
            status: 'ready',
            directives: response.directives,
          })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setExistingDirectives({
            agentId: selectedAgent.id,
            status: 'error',
            directives: [],
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [selectedAgent.id])
  const activeDirectives = existingDirectives.agentId === selectedAgent.id
    ? existingDirectives
    : { agentId: selectedAgent.id, status: 'loading' as const, directives: [] }

  const coach = useCoachState({
    selectedAgent,
    seedTurn,
    existingDirectives: activeDirectives.directives,
    directivesStatus: activeDirectives.status,
    deps: coachDeps,
    initialSnapshotId: snapshotId,
  })
  const [coachingText, setCoachingText] = useState('')
  useEffect(() => {
    if (coach.preview?.replay.run.id) {
      onPreviewCreated?.(coach.preview.replay)
    }
  }, [coach.preview?.replay, coach.preview?.replay.run.id, onPreviewCreated])
  const previewAnswer = coach.preview?.replay.answer
    ?? coach.preview?.replay.run.observedOutput.answer
    ?? ''
  // Action chips come from skill intents, not the follow-up question generator, so a
  // preview of what a suggestion-scoped directive changed must leave them out.
  const previewSuggestions = (coach.preview?.replay.suggestions ?? []).filter(
    (suggestion) => suggestion.action?.kind !== 'start_intent',
  )
  const previewsSuggestionScopedDraft = (coach.preview?.draft.directive.surfaces ?? []).includes(
    'suggested_questions',
  )
  const diagnosis = coach.preview?.draft.diagnosis
  let draftButtonLabel = 'Draft directive'
  if (activeDirectives.status === 'loading') {
    draftButtonLabel = 'Loading directives…'
  } else if (coach.status === 'drafting') {
    draftButtonLabel = 'Drafting'
  }

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
            {draftButtonLabel}
          </Button>
        </form>

        {activeDirectives.status === 'error' ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {directivesLoadErrorMessage}
          </div>
        ) : null}

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
                      <Badge variant="secondary">Every turn</Badge>
                    )}
                    <Badge variant="secondary">
                      {directiveSurfaceLabel(coach.preview.draft.directive.surfaces)
                        ?? "The agent's reply"}
                    </Badge>
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
              {previewSuggestions.length > 0 ? (
                <div className="space-y-1.5">
                  <p className="text-xs text-muted-foreground">…and offer these follow-ups</p>
                  <div className="flex flex-wrap gap-1.5">
                    {previewSuggestions.map((suggestion) => (
                      <Badge key={suggestion.text} variant="outline">{suggestion.text}</Badge>
                    ))}
                  </div>
                </div>
              ) : previewsSuggestionScopedDraft ? (
                <p className="text-xs text-muted-foreground">
                  This preview offered no follow-up questions. That may be this directive
                  suppressing them, or the agent may not be offering any on this turn — the
                  preview cannot tell the two apart, so check a turn that normally shows them.
                </p>
              ) : null}
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
    </section>
  )
}
