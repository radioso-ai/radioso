'use client'

import type { ConversationTraceStage } from '@/lib/api'
import { spineStageLabel, spineStageTelemetry, type CapabilityLeafView } from '@/lib/turn-trace'

/**
 * Minimal shape the detail renderers need from a conversation message record
 * to resolve raw user/history/answer text. The drawer's
 * `ChatConversationTurn[]` array satisfies this shape — keeping the contract
 * narrow lets the overlay accept anything message-shaped without coupling to
 * the dashboard's full message type.
 */
export interface ConversationMessageRecord {
  id?: string
  role: 'user' | 'assistant' | 'system' | 'tool' | (string & {})
  content: string
  createdAt?: string
}

interface MessageLookupContext {
  messages?: ConversationMessageRecord[]
  assistantMessageId?: string
  directiveAdherence?: DirectiveAdherenceDetail[]
}

const STATUS_LABELS: Record<ConversationTraceStage['status'], string> = {
  applied: 'Applied',
  skipped: 'Skipped',
  fallback: 'Fallback',
  rejected: 'Rejected',
  unavailable: 'Unavailable',
  failed: 'Failed',
}

const STATUS_TONE: Record<ConversationTraceStage['status'], string> = {
  applied: 'bg-emerald-500/10 text-emerald-600',
  skipped: 'bg-muted text-muted-foreground',
  fallback: 'bg-amber-500/10 text-amber-600',
  rejected: 'bg-rose-500/10 text-rose-600',
  unavailable: 'bg-muted text-muted-foreground',
  failed: 'bg-destructive/10 text-destructive',
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const asStringArray = (value: unknown): string[] =>
  asArray(value).filter((entry): entry is string => typeof entry === 'string')

interface DirectiveAdherenceDetail {
  directive: string
  ruleId: string
  satisfied: boolean
  note: string
}

const readDirectiveAdherence = (value: unknown): DirectiveAdherenceDetail[] =>
  asArray(value).flatMap((entry) => {
    if (!isRecord(entry)) return []
    const directive = asString(entry.directive)
    const ruleId = asString(entry.ruleId)
    const note = asString(entry.note)
    if (!directive || !ruleId || !note || typeof entry.satisfied !== 'boolean') return []
    return [{ directive, ruleId, satisfied: entry.satisfied, note }]
  })

function StageHeader({ stage }: { stage: ConversationTraceStage }) {
  const telemetry = spineStageTelemetry(stage)
  const hasTelemetry =
    telemetry.durationMs !== undefined ||
    telemetry.models.length > 0 ||
    telemetry.operations.length > 0 ||
    telemetry.llmCallCount !== undefined
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-base font-medium text-foreground">{spineStageLabel(stage)}</p>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[stage.status]}`}>
          {STATUS_LABELS[stage.status]}
        </span>
        <code className="text-[11px] text-muted-foreground">{stage.id}</code>
      </div>
      {hasTelemetry ? (
        <div className="space-y-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs">
          <dl className="flex flex-wrap gap-x-4 gap-y-1">
            {telemetry.durationMs !== undefined ? (
              <div>
                <dt className="inline text-muted-foreground">Duration </dt>
                <dd className="inline font-mono text-foreground">{telemetry.durationMs}ms</dd>
              </div>
            ) : null}
            {telemetry.models.length > 0 ? (
              <div>
                <dt className="inline text-muted-foreground">Model </dt>
                <dd className="inline font-mono text-foreground">{telemetry.models.join(', ')}</dd>
              </div>
            ) : null}
            {telemetry.operations.length > 0 ? (
              <div>
                <dt className="inline text-muted-foreground">Operation </dt>
                <dd className="inline font-mono text-foreground">{telemetry.operations.join(', ')}</dd>
              </div>
            ) : null}
            {telemetry.llmCallCount !== undefined ? (
              <div>
                <dt className="inline text-muted-foreground">LLM calls </dt>
                <dd className="inline font-mono text-foreground">{telemetry.llmCallCount}</dd>
              </div>
            ) : null}
            {telemetry.inputTokens !== undefined || telemetry.outputTokens !== undefined ? (
              <div>
                <dt className="inline text-muted-foreground">Tokens </dt>
                <dd className="inline font-mono text-foreground">
                  {telemetry.inputTokens ?? 0} in / {telemetry.outputTokens ?? 0} out
                  {telemetry.totalTokens !== undefined ? ` / ${telemetry.totalTokens} total` : ''}
                </dd>
              </div>
            ) : null}
            {telemetry.modelTimeMs !== undefined ? (
              <div>
                <dt className="inline text-muted-foreground">Model time </dt>
                <dd className="inline font-mono text-foreground">{telemetry.modelTimeMs}ms</dd>
              </div>
            ) : null}
          </dl>
          {telemetry.calls.length > 0 ? (
            <ol className="space-y-1 border-t border-border/60 pt-2">
              {telemetry.calls.map((call, index) => (
                <li key={`${call.operation}-${index}`} className="flex flex-wrap gap-x-3 gap-y-0.5">
                  <span className="font-mono text-foreground">{call.operation}</span>
                  <span className="font-mono text-muted-foreground">{call.model}</span>
                  {call.stageId ? <span className="font-mono text-muted-foreground">{call.stageId}</span> : null}
                  {call.durationMs !== undefined ? <span>{call.durationMs}ms</span> : null}
                  {call.inputTokens !== undefined || call.outputTokens !== undefined ? (
                    <span>{call.inputTokens ?? 0} in / {call.outputTokens ?? 0} out</span>
                  ) : null}
                  {call.status ? <span className="text-muted-foreground">{call.status}</span> : null}
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function KeyValueGrid({ record }: { record: Record<string, unknown> }) {
  const entries = Object.entries(record)
  if (!entries.length) {
    return null
  }
  return (
    <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
      {entries.map(([key, value]) => (
        <div key={key} className="min-w-0">
          <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{key}</dt>
          <dd className="mt-0.5 break-words font-mono text-xs text-foreground">
            {typeof value === 'string' ? value : JSON.stringify(value)}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function RawJson({ label, value }: { label: string; value: unknown }) {
  return (
    <details className="rounded-lg border border-border/60 bg-muted/20 p-3">
      <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </summary>
      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-xs text-foreground">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      {children}
    </section>
  )
}

const ROLE_TONE: Record<string, string> = {
  user: 'bg-primary/10 text-primary',
  assistant: 'bg-emerald-500/10 text-emerald-600',
  system: 'bg-muted text-muted-foreground',
  tool: 'bg-amber-500/10 text-amber-600',
}

function RoleBadge({ role }: { role: string }) {
  const tone = ROLE_TONE[role] ?? 'bg-muted text-muted-foreground'
  return (
    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tone}`}>
      {role}
    </span>
  )
}

/**
 * Dedicated renderers below dispatch on `stage.kind` so each first-class trace
 * step (message, gather, directive_match, skill_selection) can present the
 * data it carries in a form the user can actually read — message text, history
 * entries, the matched directives' titles + bodies, the considered skill
 * candidates and why one was picked — instead of generic key/value JSON.
 */

function MessageStageDetail({
  stage,
  ctx,
}: {
  stage: ConversationTraceStage
  ctx: MessageLookupContext
}) {
  const outputs = (stage.outputs ?? {}) as Record<string, unknown>
  const eventId = asString(outputs.eventId)
  const kind = asString(outputs.kind)
  const locale = asString(outputs.locale)
  const contentLength = asNumber(outputs.contentLength)
  // The trace carries only a reference (eventId, length, kind); the actual
  // text is read from the drawer's already-authorized conversation messages.
  // Falls back to the most recent user message if the eventId can't be
  // matched (older turns persisted before eventIds were stable).
  const lookup = ctx.messages ?? []
  const matched = eventId ? lookup.find((m) => m.id === eventId) : undefined
  const fallback = matched
    ? undefined
    : [...lookup].reverse().find((m) => m.role === 'user')
  const resolved = matched ?? fallback
  return (
    <div className="space-y-4">
      <StageHeader stage={stage} />
      <Section label="Message">
        {resolved?.content ? (
          <p className="whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/30 p-3 text-sm text-foreground">
            {resolved.content}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Message text isn&apos;t available in this view.
          </p>
        )}
      </Section>
      {(kind || locale || typeof contentLength === 'number') ? (
        <Section label="Details">
          <KeyValueGrid
            record={{
              ...(kind ? { kind } : {}),
              ...(locale ? { locale } : {}),
              ...(typeof contentLength === 'number' ? { contentLength } : {}),
            }}
          />
        </Section>
      ) : null}
    </div>
  )
}

interface HistoryRef {
  index?: number
  role?: string
  messageId?: string
  contentLength?: number
  createdAt?: string
}

function GatherStageDetail({
  stage,
  ctx,
}: {
  stage: ConversationTraceStage
  ctx: MessageLookupContext
}) {
  const outputs = (stage.outputs ?? {}) as Record<string, unknown>
  const total = asNumber(outputs.historyCount) ?? 0
  const refs = asArray(outputs.history).filter(isRecord) as HistoryRef[]
  const omitted = Math.max(total - refs.length, 0)
  // Resolved visitor context variables for the turn (already redacted upstream).
  const contextVariables = isRecord(outputs.contextVariables) ? outputs.contextVariables : null
  // History entries are referenced by messageId; the actual text comes from
  // the drawer's conversation messages (already authorized for the viewer).
  const byId = new Map((ctx.messages ?? []).map((m) => [m.id, m] as const))
  return (
    <div className="space-y-4">
      <StageHeader stage={stage} />
      {contextVariables ? (
        <Section label="Visitor context">
          <div className="space-y-2">
            {Object.entries(contextVariables).map(([name, value]) => (
              <RawJson key={name} label={name} value={value} />
            ))}
          </div>
        </Section>
      ) : null}
      <Section label={`History (${total} total${omitted > 0 ? `, showing last ${refs.length}` : ''})`}>
        {refs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No prior turns loaded.</p>
        ) : (
          <ol className="space-y-2">
            {refs.map((ref, idx) => {
              const record = ref.messageId ? byId.get(ref.messageId) : undefined
              const content = record?.content
              return (
                <li
                  key={ref.messageId ?? ref.index ?? idx}
                  className="rounded-md border border-border/60 bg-muted/20 p-2.5"
                >
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <RoleBadge role={ref.role ?? record?.role ?? 'unknown'} />
                    {typeof ref.index === 'number' ? <span>#{ref.index + 1}</span> : null}
                    {(ref.createdAt ?? record?.createdAt) ? (
                      <span>{ref.createdAt ?? record?.createdAt}</span>
                    ) : null}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-xs text-foreground">
                    {content ?? (
                      <span className="text-muted-foreground">
                        (text not available in this view)
                      </span>
                    )}
                  </p>
                </li>
              )
            })}
          </ol>
        )}
      </Section>
    </div>
  )
}

interface DirectiveDetail {
  id?: string
  name?: string
  action?: string
  description?: string
  priority?: number
  condition?: string
  selectionMode?: string
  selectionReason?: string
  selectionConfidence?: number
}

function DirectiveMatchStageDetail({
  stage,
  ctx,
}: {
  stage: ConversationTraceStage
  ctx: MessageLookupContext
}) {
  const outputs = (stage.outputs ?? {}) as Record<string, unknown>
  const matched = (asArray(outputs.directives).filter(isRecord) as DirectiveDetail[]) ?? []
  const matchCount = asNumber(outputs.matchCount) ?? matched.length
  const candidateCount = asNumber(outputs.candidateCount)
  const adherenceByDirective = new Map(ctx.directiveAdherence?.map((entry) => [entry.directive, entry]))
  return (
    <div className="space-y-4">
      <StageHeader stage={stage} />
      <Section
        label={`Matched directives (${matchCount}${
          typeof candidateCount === 'number' ? ` of ${candidateCount} considered` : ''
        })`}
      >
        {matched.length === 0 ? (
          <p className="text-sm text-muted-foreground">No directives matched this turn.</p>
        ) : (
          <ul className="space-y-2">
            {matched.map((directive, idx) => (
              <li
                key={directive.id ?? directive.name ?? idx}
                className="space-y-1.5 rounded-md border border-border/60 bg-muted/20 p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-foreground">
                    {directive.name ?? `Directive ${idx + 1}`}
                  </p>
                  {typeof directive.priority === 'number' ? (
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      priority {directive.priority}
                    </span>
                  ) : null}
                  {directive.selectionMode ? (
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {directive.selectionMode}
                    </span>
                  ) : null}
                  {directive.name && adherenceByDirective.has(directive.name) ? (
                    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                      adherenceByDirective.get(directive.name)?.satisfied
                        ? 'bg-emerald-500/10 text-emerald-600'
                        : 'bg-rose-500/10 text-rose-600'
                    }`}>
                      {adherenceByDirective.get(directive.name)?.satisfied ? 'honored' : 'not honored'}
                    </span>
                  ) : (
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      —
                    </span>
                  )}
                </div>
                {directive.action ? (
                  <p className="whitespace-pre-wrap break-words text-xs text-foreground">{directive.action}</p>
                ) : null}
                {directive.description ? (
                  <p className="text-[11px] italic text-muted-foreground">{directive.description}</p>
                ) : null}
                {directive.condition && directive.condition !== 'always' ? (
                  <p className="text-[11px] text-muted-foreground">
                    <span className="font-medium">When:</span> {directive.condition}
                  </p>
                ) : null}
                {directive.selectionReason ? (
                  <p className="text-[11px] text-muted-foreground">
                    <span className="font-medium">Why matched:</span> {directive.selectionReason}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}

interface SkillCandidate {
  name?: string
  description?: string
  selected?: boolean
}

interface ConsideredCandidate {
  skillName?: string
  selected?: boolean
  reason?: string
}

export interface ClarificationCandidateDetail {
  id?: string
  label: string
  confidence?: number
}

export interface ClarificationStageDetailView {
  surface?: string
  decision?: string
  reason?: string
  margin?: number
  candidates: ClarificationCandidateDetail[]
  chosenCandidateId?: string
  chosenCandidateLabel?: string
  alternatives: ClarificationCandidateDetail[]
  offerOutcome?: string
  labelFallback?: boolean
  mappingOutcome?: string
}

const stringifyDetailValue = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  if (isRecord(value) || Array.isArray(value)) return JSON.stringify(value)
  return undefined
}

const nestedString = (value: unknown, key: string): string | undefined =>
  isRecord(value) ? asString(value[key]) : undefined

export const buildClarificationStageDetail = (
  stage: ConversationTraceStage,
): ClarificationStageDetailView => {
  const outputs = (stage.outputs ?? {}) as Record<string, unknown>
  const decision = asString(outputs.decision)
  const reason = asString(outputs.reason)
  const candidates = asArray(outputs.candidates)
    .filter(isRecord)
    .map((candidate, index): ClarificationCandidateDetail => ({
      id: asString(candidate.id),
      label: asString(candidate.label) ?? asString(candidate.id) ?? `Candidate ${index + 1}`,
      confidence: asNumber(candidate.confidence),
    }))
  const chosenCandidateId = asString(outputs.chosenCandidateId)
  const chosenCandidate = chosenCandidateId
    ? candidates.find((candidate) => candidate.id === chosenCandidateId)
    : undefined
  const alternatives = decision === 'offered' && chosenCandidateId
    ? candidates.filter((candidate) => candidate.id !== chosenCandidateId)
    : []
  const mappingOutcome = stringifyDetailValue(outputs.mappingOutcome)
  const offerOutcome =
    asString(outputs.offerOutcome) ??
    nestedString(outputs.mappingOutcome, 'offerOutcome') ??
    nestedString(outputs.resolution, 'offerOutcome') ??
    asString(outputs.resolutionOutcome)
  const labelFallback =
    reason === 'label_fallback' ||
    outputs.labelFallback === true ||
    asString(outputs.fallbackReason) === 'label_fallback' ||
    asString(outputs.labelFallbackReason) === 'label_fallback'

  return {
    surface: asString(outputs.surface),
    decision,
    reason,
    margin: asNumber(outputs.margin),
    candidates,
    chosenCandidateId,
    chosenCandidateLabel: chosenCandidate?.label,
    alternatives,
    offerOutcome,
    labelFallback,
    mappingOutcome,
  }
}

function ClarificationStageDetail({ stage }: { stage: ConversationTraceStage }) {
  const detail = buildClarificationStageDetail(stage)

  return (
    <div className="space-y-4">
      <StageHeader stage={stage} />
      <Section label="Decision">
        <div className="flex flex-wrap items-center gap-2">
          {detail.surface ? (
            <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
              {detail.surface}
            </span>
          ) : null}
          {detail.decision ? (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
              {detail.decision}
            </span>
          ) : (
            <span className="text-sm text-muted-foreground">No decision recorded.</span>
          )}
        </div>
        {(detail.reason || typeof detail.margin === 'number' || detail.offerOutcome || detail.labelFallback || detail.mappingOutcome) ? (
          <KeyValueGrid
            record={{
              ...(detail.reason ? { reason: detail.reason } : {}),
              ...(typeof detail.margin === 'number' ? { margin: detail.margin } : {}),
              ...(detail.labelFallback ? { labelFallback: true } : {}),
              ...(detail.offerOutcome ? { offerOutcome: detail.offerOutcome } : {}),
              ...(detail.mappingOutcome ? { mappingOutcome: detail.mappingOutcome } : {}),
            }}
          />
        ) : null}
      </Section>
      {(detail.chosenCandidateId || detail.alternatives.length > 0) ? (
        <Section label="Offer">
          <KeyValueGrid
            record={{
              ...(detail.chosenCandidateId ? { winner: detail.chosenCandidateLabel ?? detail.chosenCandidateId } : {}),
              ...(detail.alternatives.length > 0
                ? { alternatives: detail.alternatives.map((candidate) => candidate.label).join(', ') }
                : {}),
            }}
          />
        </Section>
      ) : null}
      <Section label={`Candidates (${detail.candidates.length})`}>
        {detail.candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">No candidates recorded for this decision.</p>
        ) : (
          <ul className="space-y-1.5">
            {detail.candidates.map((candidate, idx) => (
              <li
                key={candidate.id ?? candidate.label ?? idx}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/20 p-2.5"
              >
                <span className="text-sm font-medium text-foreground">{candidate.label}</span>
                {typeof candidate.confidence === 'number' ? (
                  <span className="font-mono text-xs text-muted-foreground">{candidate.confidence}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}

function SkillSelectionStageDetail({ stage }: { stage: ConversationTraceStage }) {
  const outputs = (stage.outputs ?? {}) as Record<string, unknown>
  const reason = asString(outputs.reason)
  const selected = asArray(outputs.selectedSkills).filter((value): value is string => typeof value === 'string')
  const candidates = (asArray(outputs.candidates).filter(isRecord) as SkillCandidate[]) ?? []
  const considered = (asArray(outputs.considered).filter(isRecord) as ConsideredCandidate[]) ?? []
  const reasonByName = new Map(
    considered
      .filter((entry) => typeof entry.skillName === 'string')
      .map((entry) => [entry.skillName!, entry.reason]),
  )

  return (
    <div className="space-y-4">
      <StageHeader stage={stage} />
      {reason ? (
        <Section label="Reason">
          <p className="whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/20 p-3 text-sm text-foreground">
            {reason}
          </p>
        </Section>
      ) : null}
      <Section label="Selected">
        {selected.length === 0 ? (
          <p className="text-sm text-muted-foreground">No skill was selected for this turn.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {selected.map((name) => (
              <li
                key={name}
                className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-[11px] text-primary"
              >
                {name}
              </li>
            ))}
          </ul>
        )}
      </Section>
      {candidates.length > 0 ? (
        <Section label={`Candidates considered (${candidates.length})`}>
          <ul className="space-y-1.5">
            {candidates.map((candidate, idx) => {
              const name = candidate.name ?? `candidate-${idx}`
              const candidateReason = reasonByName.get(name)
              return (
                <li
                  key={name}
                  className={`flex flex-col gap-0.5 rounded-md border p-2 ${
                    candidate.selected
                      ? 'border-primary/30 bg-primary/5'
                      : 'border-border/60 bg-muted/20'
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-foreground">{name}</span>
                    {candidate.selected ? (
                      <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                        selected
                      </span>
                    ) : null}
                  </div>
                  {candidate.description ? (
                    <p className="text-[11px] text-muted-foreground">{candidate.description}</p>
                  ) : null}
                  {candidateReason ? (
                    <p className="text-[11px] text-muted-foreground">{candidateReason}</p>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </Section>
      ) : null}
    </div>
  )
}

interface ComposeOutcomeSummary {
  skillName?: string
  status?: string
  errorCode?: string
  errorMessage?: string
  answerLength?: number
}

const resolveAssistantAnswer = (ctx: MessageLookupContext): string | undefined => {
  const messages = ctx.messages ?? []
  if (ctx.assistantMessageId) {
    const matched = messages.find((m) => m.id === ctx.assistantMessageId)
    if (matched?.content) return matched.content
  }
  return [...messages].reverse().find((m) => m.role === 'assistant')?.content
}

function ComposeStageDetail({
  stage,
  ctx,
}: {
  stage: ConversationTraceStage
  ctx: MessageLookupContext
}) {
  const outputs = (stage.outputs ?? {}) as Record<string, unknown>
  // The assistant's answer is the chat message produced by this turn; the
  // trace records only its length. The actual text comes from the drawer's
  // message records (already authorized for the viewer).
  const answer = resolveAssistantAnswer(ctx)
  const answerLength = asNumber(outputs.answerLength)
  const citationCount = asNumber(outputs.citationCount)
  const suggestionCount = asNumber(outputs.suggestionCount)
  const outcomeCount = asNumber(outputs.outcomeCount)
  const streamed = typeof outputs.streamed === 'boolean' ? outputs.streamed : undefined
  const outcomes = (asArray(outputs.outcomes).filter(isRecord) as ComposeOutcomeSummary[]) ?? []
  const adherence = readDirectiveAdherence(outputs.adherence)
  return (
    <div className="space-y-4">
      <StageHeader stage={stage} />
      <Section label="Answer">
        {answer ? (
          <p className="whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/30 p-3 text-sm text-foreground">
            {answer}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Answer text isn&apos;t available in this view.
          </p>
        )}
      </Section>
      {(typeof answerLength === 'number' ||
        typeof citationCount === 'number' ||
        typeof suggestionCount === 'number' ||
        typeof outcomeCount === 'number' ||
        typeof streamed === 'boolean') ? (
        <Section label="Details">
          <KeyValueGrid
            record={{
              ...(typeof answerLength === 'number' ? { answerLength } : {}),
              ...(typeof citationCount === 'number' ? { citationCount } : {}),
              ...(typeof suggestionCount === 'number' ? { suggestionCount } : {}),
              ...(typeof outcomeCount === 'number' ? { outcomeCount } : {}),
              ...(typeof streamed === 'boolean' ? { streamed } : {}),
            }}
          />
        </Section>
      ) : null}
      {adherence.length > 0 ? (
        <Section label={`Adherence (${adherence.length})`}>
          <ul className="space-y-1.5">
            {adherence.map((entry) => (
              <li key={entry.ruleId} className="rounded-md border border-border/60 bg-muted/20 p-2.5">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium text-foreground">{entry.directive}</span>
                  <span className={entry.satisfied ? 'text-emerald-600' : 'text-rose-600'}>
                    {entry.satisfied ? '✓' : '✗'}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{entry.note}</p>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {outcomes.length > 0 ? (
        <Section label={`Outcomes (${outcomes.length})`}>
          <ul className="space-y-1.5">
            {outcomes.map((outcome, idx) => (
              <li
                key={outcome.skillName ?? idx}
                className="space-y-1 rounded-md border border-border/60 bg-muted/20 p-2.5"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-foreground">
                    {outcome.skillName ?? 'unknown skill'}
                  </span>
                  {outcome.status ? (
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {outcome.status}
                    </span>
                  ) : null}
                  {typeof outcome.answerLength === 'number' ? (
                    <span className="text-[11px] text-muted-foreground">
                      {outcome.answerLength} chars
                    </span>
                  ) : null}
                </div>
                {outcome.errorMessage ? (
                  <p className="text-[11px] text-destructive">
                    {outcome.errorCode ? `${outcome.errorCode}: ` : ''}
                    {outcome.errorMessage}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  )
}

/** One step's outcome as the runner walked the routine graph this turn. */
export interface RoutineTraceStepView {
  stepId: string
  kind: string
  event: string
  capturedSlotKeys: string[]
  viaSelector: boolean
  skillName?: string
  skillStatus?: string
}

export interface RoutineRunTraceView {
  startStepId?: string
  landedStepId?: string
  terminalKind?: string
  capturedSlotKeys: string[]
  filledSlotKeys: string[]
  steps: RoutineTraceStepView[]
}

/**
 * Parse the routine stage's `routine` sub-trace into a renderable, metadata-safe
 * step-by-step view. Carries slot *keys* only — the runner never puts captured
 * values on the trace, and this defensively ignores anything else on the payload.
 * Returns undefined when the stage has no routine sub-trace.
 */
export const buildRoutineRunTrace = (
  stage: ConversationTraceStage,
): RoutineRunTraceView | undefined => {
  const subTrace = stage.subTrace
  if (!subTrace || subTrace.namespace !== 'routine' || !isRecord(subTrace.payload)) {
    return undefined
  }
  const payload = subTrace.payload
  const steps = asArray(payload.steps)
    .filter(isRecord)
    .map((entry): RoutineTraceStepView => ({
      stepId: asString(entry.stepId) ?? '',
      kind: asString(entry.kind) ?? 'chat',
      event: asString(entry.event) ?? '',
      capturedSlotKeys: asStringArray(entry.capturedSlotKeys),
      viaSelector: entry.viaSelector === true,
      ...(asString(entry.skillName) ? { skillName: asString(entry.skillName) } : {}),
      ...(asString(entry.skillStatus) ? { skillStatus: asString(entry.skillStatus) } : {}),
    }))
  return {
    startStepId: asString(payload.startStepId),
    landedStepId: asString(payload.landedStepId),
    terminalKind: asString(payload.terminalKind),
    capturedSlotKeys: asStringArray(payload.capturedSlotKeys),
    filledSlotKeys: asStringArray(payload.filledSlotKeys),
    steps,
  }
}

const ROUTINE_EVENT_LABELS: Record<string, string> = {
  resumed: 'Resumed',
  advanced: 'Advanced',
  reasked: 'Re-asked',
  fast_forwarded: 'Skipped',
  skill_dispatched: 'Tool ran',
  action_emitted: 'Action sent',
  rendered: 'Replied here',
}

// Plain-language one-liners so the timeline reads without knowing the engine's terms.
const ROUTINE_EVENT_DESCRIPTIONS: Record<string, string> = {
  resumed: 'Where the routine picked up this turn.',
  advanced: 'The step was satisfied, so the routine moved on.',
  reasked: 'The routine stayed on this step and asked again.',
  fast_forwarded: 'Skipped without asking — every slot it collects was already filled.',
  skill_dispatched: 'Ran this step’s tool.',
  action_emitted: 'Emitted a fire-and-forget action.',
  rendered: 'The reply you saw was generated from this step.',
}

const ROUTINE_EVENT_TONE: Record<string, string> = {
  advanced: 'bg-emerald-500/10 text-emerald-600',
  reasked: 'bg-amber-500/10 text-amber-600',
  fast_forwarded: 'bg-sky-500/10 text-sky-600',
  skill_dispatched: 'bg-primary/10 text-primary',
  action_emitted: 'bg-primary/10 text-primary',
  rendered: 'bg-muted text-muted-foreground',
}

function SlotKeyChips({ keys, tone }: { keys: string[]; tone: string }) {
  return (
    <ul className="flex flex-wrap gap-1">
      {keys.map((key) => (
        <li key={key} className={`rounded-full px-1.5 py-0.5 font-mono text-[10px] ${tone}`}>
          {key}
        </li>
      ))}
    </ul>
  )
}

function RoutineStepsTimeline({ trace }: { trace: RoutineRunTraceView }) {
  return (
    <Section label={`Steps this turn (${trace.steps.length})`}>
      {trace.steps.length === 0 ? (
        <p className="text-sm text-muted-foreground">No step activity recorded for this turn.</p>
      ) : (
        <ol className="space-y-1.5">
          {trace.steps.map((step, idx) => (
            <li
              key={`${step.stepId}:${step.event}:${idx}`}
              className="space-y-1 rounded-md border border-border/60 bg-muted/20 p-2.5"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-muted-foreground">{idx + 1}.</span>
                <code className="text-xs text-foreground">{step.stepId}</code>
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                    ROUTINE_EVENT_TONE[step.event] ?? 'bg-muted text-muted-foreground'
                  }`}
                >
                  {ROUTINE_EVENT_LABELS[step.event] ?? step.event}
                </span>
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{step.kind}</span>
                {step.viaSelector ? (
                  <span
                    className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                    title="The LLM next-step selector ran here — it judged the condition and extracted any slots."
                  >
                    AI selector
                  </span>
                ) : null}
              </div>
              {ROUTINE_EVENT_DESCRIPTIONS[step.event] ? (
                <p className="text-[11px] text-muted-foreground">{ROUTINE_EVENT_DESCRIPTIONS[step.event]}</p>
              ) : null}
              {step.skillName ? (
                <p className="text-[11px] text-muted-foreground">
                  Tool <code className="text-foreground">{step.skillName}</code>
                  {step.skillStatus ? ` → ${step.skillStatus}` : ''}
                </p>
              ) : null}
              {step.capturedSlotKeys.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">captured</span>
                  <SlotKeyChips keys={step.capturedSlotKeys} tone="bg-emerald-500/10 text-emerald-600" />
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </Section>
  )
}

function RoutineStageDetail({
  stage,
  ctx,
}: {
  stage: ConversationTraceStage
  ctx: MessageLookupContext
}) {
  const outputs = (stage.outputs ?? {}) as Record<string, unknown>
  const answer = resolveAssistantAnswer(ctx)
  const answerLength = asNumber(outputs.answerLength)
  const routineId = asString(outputs.routineId)
  const completed = typeof outputs.completed === 'boolean' ? outputs.completed : undefined
  const trace = buildRoutineRunTrace(stage)
  const capturedThisTurn = new Set(trace?.capturedSlotKeys ?? [])
  return (
    <div className="space-y-4">
      <StageHeader stage={stage} />
      <Section label="Answer">
        {answer ? (
          <p className="whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/30 p-3 text-sm text-foreground">
            {answer}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Answer text isn&apos;t available in this view.
          </p>
        )}
      </Section>
      {trace ? <RoutineStepsTimeline trace={trace} /> : null}
      {trace && (trace.filledSlotKeys.length > 0 || trace.capturedSlotKeys.length > 0) ? (
        <Section label={`Slots filled (${trace.filledSlotKeys.length})`}>
          {trace.filledSlotKeys.length === 0 ? (
            <p className="text-sm text-muted-foreground">No slots filled yet.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {trace.filledSlotKeys.map((key) => (
                <li
                  key={key}
                  className={`rounded-full px-2 py-0.5 font-mono text-[11px] ${
                    capturedThisTurn.has(key)
                      ? 'bg-emerald-500/10 text-emerald-600'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {key}
                  {capturedThisTurn.has(key) ? <span className="ml-1 not-italic">• new</span> : null}
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}
      {(routineId || typeof completed === 'boolean' || typeof answerLength === 'number' || trace?.terminalKind) ? (
        <Section label="Routine">
          <KeyValueGrid
            record={{
              ...(routineId ? { routineId } : {}),
              ...(trace?.startStepId ? { startStep: trace.startStepId } : {}),
              ...(trace?.landedStepId ? { landedStep: trace.landedStepId } : {}),
              ...(trace?.terminalKind ? { terminalKind: trace.terminalKind } : {}),
              ...(typeof completed === 'boolean' ? { completed } : {}),
              ...(typeof answerLength === 'number' ? { answerLength } : {}),
            }}
          />
        </Section>
      ) : null}
    </div>
  )
}

function GenericStageDetail({ stage }: { stage: ConversationTraceStage }) {
  const inputs = (stage.inputs ?? {}) as Record<string, unknown>
  const outputs = (stage.outputs ?? {}) as Record<string, unknown>
  const metrics = (stage.metrics ?? {}) as Record<string, unknown>

  return (
    <div className="space-y-4">
      <StageHeader stage={stage} />

      {Object.keys(outputs).length ? (
        <Section label="Outputs">
          <KeyValueGrid record={outputs} />
        </Section>
      ) : null}

      {Object.keys(inputs).length ? (
        <Section label="Inputs">
          <KeyValueGrid record={inputs} />
        </Section>
      ) : null}

      {Object.keys(metrics).length ? (
        <Section label="Metrics">
          <KeyValueGrid record={metrics} />
        </Section>
      ) : null}

      {!Object.keys(outputs).length && !Object.keys(inputs).length && !Object.keys(metrics).length ? (
        <p className="text-sm text-muted-foreground">No recorded inputs or outputs for this stage.</p>
      ) : null}
    </div>
  )
}

/**
 * Detail for a conversation spine stage. Dispatches on `stage.kind` so each
 * first-class step (message, gather, directive_match, skill_selection,
 * compose, routine) gets a dedicated renderer.
 *
 * Conversation text never lives in the trace itself — that envelope lands in
 * audit/debug metadata where raw prompts/completions are disallowed. Instead,
 * the message/gather/compose/routine renderers receive the drawer's already
 * authorized message records and join back to them by id/role to display the
 * actual user message, history entries, and assistant answer.
 */
export function SpineStageDetail({
  stage,
  messages,
  assistantMessageId,
  directiveAdherence,
}: {
  stage: ConversationTraceStage
  messages?: ConversationMessageRecord[]
  assistantMessageId?: string
  directiveAdherence?: DirectiveAdherenceDetail[]
}) {
  const ctx: MessageLookupContext = { messages, assistantMessageId, directiveAdherence }
  switch (stage.kind) {
    case 'message':
      return <MessageStageDetail stage={stage} ctx={ctx} />
    case 'gather':
      return <GatherStageDetail stage={stage} ctx={ctx} />
    case 'directive_match':
    // Routine turns trace co-composed directives under `directive_steering` with
    // the same directive summary payload, so it falls through to the same view.
    case 'directive_steering':
      return <DirectiveMatchStageDetail stage={stage} ctx={ctx} />
    case 'skill_selection':
      return <SkillSelectionStageDetail stage={stage} />
    case 'clarification':
      return <ClarificationStageDetail stage={stage} />
    case 'compose':
      return <ComposeStageDetail stage={stage} ctx={ctx} />
    case 'routine_resume':
    case 'routine_activate':
      return <RoutineStageDetail stage={stage} ctx={ctx} />
    default:
      return <GenericStageDetail stage={stage} />
  }
}

/**
 * Fallback detail for a capability leaf whose namespace has no dedicated
 * renderer yet — shows the namespace, version, and raw payload so new capability
 * traces are inspectable before they earn a bespoke view.
 */
export function RawCapabilityDetail({ leaf }: { leaf: Extract<CapabilityLeafView, { kind: 'raw' }> }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-base font-medium text-foreground">{leaf.namespace}</p>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          sub-trace
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        No dedicated renderer for the “{leaf.namespace}” capability yet.
      </p>
      <RawJson label="Raw payload" value={leaf.payload} />
    </div>
  )
}
