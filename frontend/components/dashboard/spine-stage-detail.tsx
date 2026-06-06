'use client'

import type { ConversationTraceStage } from '@/lib/api'
import { spineStageLabel, type CapabilityLeafView } from '@/lib/turn-trace'

/**
 * Minimal shape the detail renderers need from a conversation message record
 * to resolve raw user/history/answer text. The drawer's
 * `ChatConversationTurn[]` array satisfies this shape — keeping the contract
 * narrow lets the overlay accept anything message-shaped without coupling to
 * the dashboard's full message type.
 */
export interface ConversationMessageRecord {
  id?: string
  role: 'user' | 'assistant' | 'system' | 'tool' | string
  content: string
  createdAt?: string
}

interface MessageLookupContext {
  messages?: ConversationMessageRecord[]
  assistantMessageId?: string
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

function StageHeader({ stage }: { stage: ConversationTraceStage }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="text-base font-medium text-foreground">{spineStageLabel(stage)}</p>
      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[stage.status]}`}>
        {STATUS_LABELS[stage.status]}
      </span>
      <code className="text-[11px] text-muted-foreground">{stage.id}</code>
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
  // History entries are referenced by messageId; the actual text comes from
  // the drawer's conversation messages (already authorized for the viewer).
  const byId = new Map((ctx.messages ?? []).map((m) => [m.id, m] as const))
  return (
    <div className="space-y-4">
      <StageHeader stage={stage} />
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

function DirectiveMatchStageDetail({ stage }: { stage: ConversationTraceStage }) {
  const outputs = (stage.outputs ?? {}) as Record<string, unknown>
  const matched = (asArray(outputs.directives).filter(isRecord) as DirectiveDetail[]) ?? []
  const matchCount = asNumber(outputs.matchCount) ?? matched.length
  const candidateCount = asNumber(outputs.candidateCount)
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
      {(routineId || typeof completed === 'boolean' || typeof answerLength === 'number') ? (
        <Section label="Routine">
          <KeyValueGrid
            record={{
              ...(routineId ? { routineId } : {}),
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
}: {
  stage: ConversationTraceStage
  messages?: ConversationMessageRecord[]
  assistantMessageId?: string
}) {
  const ctx: MessageLookupContext = { messages, assistantMessageId }
  switch (stage.kind) {
    case 'message':
      return <MessageStageDetail stage={stage} ctx={ctx} />
    case 'gather':
      return <GatherStageDetail stage={stage} ctx={ctx} />
    case 'directive_match':
      return <DirectiveMatchStageDetail stage={stage} />
    case 'skill_selection':
      return <SkillSelectionStageDetail stage={stage} />
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
