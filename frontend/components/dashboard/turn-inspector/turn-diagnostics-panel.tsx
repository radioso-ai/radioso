'use client'

import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

import { ActivityTraceDetail } from '@/components/dashboard/activity-trace-detail'
import { ActivityTraceGraph } from '@/components/dashboard/activity-trace-graph'
import { type ChatConversationTurn, type TurnTraceEnvelope } from '@/lib/api'
import {
  type DiagnosticPresentation,
  presentActivityOutcome,
  presentRunParameters,
} from '@/lib/activity-diagnostics'
import {
  clarificationDecisionFromSpine,
  routineTurnSignalFromSpine,
  turnTraceRollup,
} from '@/lib/turn-trace'

type ChatConversationTurnDebug = NonNullable<ChatConversationTurn['debug']>

/**
 * Normalized diagnostics for a single assistant turn, independent of whether the
 * turn came from the history API (nested under `message.debug`) or the live chat
 * stream (fields carried on the client `ChatMessage`). Both surfaces map their
 * own message shape into this so the inspector renders identically.
 */
export interface TurnDiagnosticsInput {
  /** Id of the message the operator selected (shown as the copyable Message id). */
  messageId: string
  route?: ChatConversationTurnDebug['route']
  answerOutcome?: ChatConversationTurnDebug['answerOutcome']
  errorMessage?: string
  /** Already-resolved leaf trace (primary retrieval leaf or legacy activity trace). */
  activityTrace?: ChatConversationTurnDebug['activityTrace']
  /** Turn spine envelope; drives routine/clarification signals and the flow graph. */
  turnTrace?: TurnTraceEnvelope
  visitorContext?: unknown
}

const toneStyles: Record<DiagnosticPresentation['tone'], string> = {
  neutral: 'border-border/70 bg-background/60',
  ok: 'border-emerald-500/30 bg-emerald-500/10',
  warning: 'border-amber-500/30 bg-amber-500/10',
  error: 'border-destructive/30 bg-destructive/10',
}

export function CompactIdField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition hover:bg-muted/50"
      title={`Copy ${label} ID: ${value}`}
    >
      <span className="shrink-0 font-medium text-muted-foreground">{label}</span>
      <code className="min-w-0 truncate font-mono text-foreground">{value}</code>
      {copied ? <Check className="h-3 w-3 shrink-0 text-green-500" /> : <Copy className="h-3 w-3 shrink-0 text-muted-foreground" />}
    </button>
  )
}

export function DiagnosticPresentationSection({
  label,
  presentation,
}: {
  label: string
  presentation: DiagnosticPresentation
}) {
  return (
    <section className={`rounded-lg border p-3 ${toneStyles[presentation.tone]}`}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-base font-medium text-foreground">{presentation.title}</p>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">{presentation.summary}</p>
      {presentation.facts.length ? (
        <dl className="mt-3 grid gap-x-4 gap-y-2 sm:grid-cols-2">
          {presentation.facts.map((fact) => (
            <div key={`${label}-${fact.label}`} className="min-w-0">
              <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{fact.label}</dt>
              <dd className="mt-0.5 break-words text-sm text-foreground">{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  )
}

/**
 * Shared turn diagnostics view. Renders the outcome summary, run parameters, and
 * — for legacy turns without a spine envelope — the inline activity-trace
 * explorer. Envelope turns defer the full graph to the caller's Flow overlay.
 */
export function TurnDiagnosticsPanel({
  diagnostics,
  routineNamesById,
  selectedStageId,
  onSelectLeafStage,
}: {
  diagnostics: TurnDiagnosticsInput | null
  routineNamesById?: ReadonlyMap<string, string>
  selectedStageId?: string
  onSelectLeafStage: (stageId: string) => void
}) {
  if (!diagnostics) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
        Select a message to inspect diagnostics.
      </div>
    )
  }

  const resolvedActivityTrace = diagnostics.activityTrace
  const activeEnvelope = diagnostics.turnTrace
  // The outcome summary reads from the turn spine — which knows a routine drove
  // the reply or that a clarification was asked — so it can be specific instead
  // of flattening everything that isn't retrieval to a "direct reply".
  const spine = diagnostics.turnTrace?.spine
  const routineSignal = routineTurnSignalFromSpine(spine)
  const routineName = routineSignal ? routineNamesById?.get(routineSignal.routineId) : undefined
  const outcomePresentation = presentActivityOutcome({
    trace: resolvedActivityTrace,
    route: diagnostics.route,
    answerOutcome: diagnostics.answerOutcome,
    routine: routineSignal ? { name: routineName, completed: routineSignal.completed } : undefined,
    clarificationAsked: clarificationDecisionFromSpine(spine) === 'asked',
  })
  const runParameters = presentRunParameters(resolvedActivityTrace)
  const rollup = turnTraceRollup(activeEnvelope)

  return (
    <div className="space-y-4">
      <CompactIdField label="Message" value={diagnostics.messageId} />

      {diagnostics.errorMessage ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {diagnostics.errorMessage}
        </div>
      ) : null}

      <DiagnosticPresentationSection label="Outcome summary" presentation={outcomePresentation} />

      {rollup ? (
        <section className="rounded-lg border border-border/70 bg-background/60 p-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Turn performance</p>
          <dl className="mt-3 grid gap-x-4 gap-y-2 sm:grid-cols-2">
            {[
              { label: 'Turn time', value: `${rollup.totalTurnWallClockMs}ms` },
              { label: 'Model time', value: `${rollup.totalModelTimeMs}ms` },
              { label: 'LLM calls', value: String(rollup.totalLlmCalls) },
              { label: 'Serial LLM depth', value: String(rollup.serialLlmDepth) },
              {
                label: 'Longest stage',
                value: `${rollup.longestStage.name.replaceAll('_', ' ')} · ${rollup.longestStage.durationMs}ms`,
              },
            ].map((fact) => (
              <div key={fact.label} className="min-w-0">
                <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{fact.label}</dt>
                <dd className="mt-0.5 break-words font-mono text-sm text-foreground">{fact.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {runParameters ? (
        <DiagnosticPresentationSection label="Run parameters" presentation={runParameters} />
      ) : null}

      {/* The turn flow opens full-screen from the header (envelope turns). Legacy
          turns without an envelope keep the inline flat activity trace explorer. */}
      {activeEnvelope ? (
        <p className="text-xs text-muted-foreground">
          Open <span className="font-medium text-foreground">Flow</span> to explore this turn as a graph —
          inputs flow into the engine, which selects a skill and its retrieval path, leading to the outcome.
        </p>
      ) : (
        <div className="grid grid-cols-[minmax(200px,260px)_1fr] gap-4">
          <div className="sticky top-0 self-start overflow-y-auto rounded-lg border border-border/50 bg-muted/20 p-2">
            {resolvedActivityTrace ? (
              <ActivityTraceGraph
                activityTrace={resolvedActivityTrace}
                selectedStageId={selectedStageId ?? resolvedActivityTrace.stages[0]?.stageId ?? ''}
                onSelectStage={onSelectLeafStage}
              />
            ) : (
              <div className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
                Activity trace unavailable for this turn.
              </div>
            )}
          </div>
          <div className="min-h-0">
            <ActivityTraceDetail
              activityTrace={resolvedActivityTrace}
              selectedStageId={selectedStageId}
              visitorContext={diagnostics.visitorContext}
            />
          </div>
        </div>
      )}
    </div>
  )
}
