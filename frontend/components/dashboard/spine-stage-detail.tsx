'use client'

import type { ConversationTraceStage } from '@/lib/api'
import { spineStageLabel, type CapabilityLeafView } from '@/lib/turn-trace'

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

/**
 * Generic detail for a conversation spine stage that has no capability leaf
 * (gather, directives, selection, compose, routine steps). Renders the stage's
 * status and its inputs/outputs/metrics without assuming any capability shape.
 */
export function SpineStageDetail({ stage }: { stage: ConversationTraceStage }) {
  const inputs = (stage.inputs ?? {}) as Record<string, unknown>
  const outputs = (stage.outputs ?? {}) as Record<string, unknown>
  const metrics = (stage.metrics ?? {}) as Record<string, unknown>

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-base font-medium text-foreground">{spineStageLabel(stage)}</p>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[stage.status]}`}>
          {STATUS_LABELS[stage.status]}
        </span>
        <code className="text-[11px] text-muted-foreground">{stage.id}</code>
      </div>

      {Object.keys(outputs).length ? (
        <section className="space-y-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Outputs</p>
          <KeyValueGrid record={outputs} />
        </section>
      ) : null}

      {Object.keys(inputs).length ? (
        <section className="space-y-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Inputs</p>
          <KeyValueGrid record={inputs} />
        </section>
      ) : null}

      {Object.keys(metrics).length ? (
        <section className="space-y-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Metrics</p>
          <KeyValueGrid record={metrics} />
        </section>
      ) : null}

      {!Object.keys(outputs).length && !Object.keys(inputs).length && !Object.keys(metrics).length ? (
        <p className="text-sm text-muted-foreground">No recorded inputs or outputs for this stage.</p>
      ) : null}
    </div>
  )
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
