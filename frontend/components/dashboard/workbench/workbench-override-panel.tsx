'use client'

import { useEffect, useMemo, useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'

import { ModelPicker } from '@/components/dashboard/settings/model-picker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  emptyKnownModelsByProvider,
  llmProviderNames,
  llmProvidersApi,
  providerDisplayName,
  type KnownModelsByProvider,
  type LlmProviderName,
} from '@/lib/api-llm-providers'
import type { RetrievalSkillSettingsOverride, RetrievalStrategy } from '@/lib/retrieval-skill-settings'
import type { EvalRunRoutineStartStateInput } from '@/lib/api-eval'
import type { RoutineDefinition } from '@/lib/api-types'
import type {
  WorkbenchOverrideAction,
  WorkbenchOverrideState,
  WorkbenchOverrideValues,
} from './use-workbench-state'

const retrievalStrategies: RetrievalStrategy[] = ['auto', 'fixed', 'reasoning']

const stepLabel = (step: RoutineDefinition['steps'][number]): string => {
  const outline = step.metadata?.outlineLabel
  if (typeof outline === 'string' && outline.length > 0) return outline
  return step.instruction || step.stableStepId
}

/**
 * Authors a mid-routine starting position for a replay: pick a published routine, the
 * step to resume at, and any slot values already collected. Emits the full
 * RoutineState (status "active", path = [step]) so the replay resumes there. Capturing
 * an exact routine position from a real conversation is the snapshot's job; this is for
 * synthetic "what if we were at step X with these slots" testing.
 */
function RoutineStartStateSection({
  routines,
  enabled,
  value,
  dispatch,
}: {
  routines: RoutineDefinition[]
  enabled: boolean
  value: EvalRunRoutineStartStateInput | null
  dispatch: (action: WorkbenchOverrideAction) => void
}) {
  const selectedRoutine = routines.find((routine) => routine.id === value?.routineId) ?? null
  const selectedStepId = value?.path[value.path.length - 1] ?? ''

  const emit = (next: Partial<EvalRunRoutineStartStateInput> & { routineId: string }) => {
    dispatch({
      type: 'set-routine-start-state',
      value: {
        routineId: next.routineId,
        path: next.path ?? (next.routineId === value?.routineId ? value?.path ?? [] : []),
        variables: next.variables ?? (next.routineId === value?.routineId ? value?.variables ?? {} : {}),
        status: 'active',
      },
    })
  }

  return (
    <section className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">Resume mid-routine</h3>
          <p className="text-xs text-muted-foreground">
            Start this replay inside a routine, at a chosen step with slots pre-filled, to test a later step.
          </p>
        </div>
        <OverrideToggle
          checked={enabled}
          label="Resume mid-routine"
          onCheckedChange={(checked) => {
            dispatch({ type: 'set-routine-start-state', value: checked ? value : null })
          }}
        />
      </div>

      {enabled ? (
        routines.length === 0 ? (
          <p className="text-xs text-muted-foreground">This agent has no published routines to resume.</p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground">Routine</label>
              <Select
                value={value?.routineId ?? ''}
                onValueChange={(routineId) => emit({ routineId, path: [], variables: {} })}
              >
                <SelectTrigger aria-label="Routine">
                  <SelectValue placeholder="Select a routine" />
                </SelectTrigger>
                <SelectContent>
                  {routines.map((routine) => (
                    <SelectItem key={routine.id} value={routine.id}>
                      {routine.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {selectedRoutine ? (
              <>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-foreground">Resume at step</label>
                  <Select
                    value={selectedStepId}
                    onValueChange={(stepId) => emit({ routineId: selectedRoutine.id, path: [stepId] })}
                  >
                    <SelectTrigger aria-label="Resume at step">
                      <SelectValue placeholder="Select a step" />
                    </SelectTrigger>
                    <SelectContent>
                      {selectedRoutine.steps.map((step) => (
                        <SelectItem key={step.stableStepId} value={step.stableStepId}>
                          {stepLabel(step)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {selectedRoutine.slots.length > 0 ? (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-foreground">Collected slots</p>
                    {selectedRoutine.slots.map((slot) => (
                      <div key={slot.stableSlotId} className="space-y-1">
                        <label className="text-xs text-muted-foreground" htmlFor={`slot-${slot.stableSlotId}`}>
                          {slot.key}
                        </label>
                        <Input
                          id={`slot-${slot.stableSlotId}`}
                          value={String(value?.variables?.[slot.key] ?? '')}
                          onChange={(event) =>
                            emit({
                              routineId: selectedRoutine.id,
                              variables: { ...(value?.variables ?? {}), [slot.key]: event.target.value },
                            })
                          }
                        />
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        )
      ) : null}
    </section>
  )
}

function OverrideToggle({
  checked,
  onCheckedChange,
  label,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label: string
}) {
  return (
    <div className="flex items-center gap-2">
      <Switch checked={checked} onCheckedChange={onCheckedChange} aria-label={label} />
      <span className="text-xs text-muted-foreground">Override</span>
    </div>
  )
}

function numberOrFallback(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function WorkbenchOverridePanel({
  baseline,
  state,
  dispatch,
  routines = [],
  variant = 'sidebar',
}: {
  baseline: WorkbenchOverrideValues
  state: WorkbenchOverrideState
  dispatch: (action: WorkbenchOverrideAction) => void
  routines?: RoutineDefinition[]
  variant?: 'sidebar' | 'embedded' | 'drawer'
}) {
  const [knownModels, setKnownModels] = useState<KnownModelsByProvider>(emptyKnownModelsByProvider)

  useEffect(() => {
    let cancelled = false
    void llmProvidersApi.getModels()
      .then((response) => {
        if (!cancelled) setKnownModels(response.knownModelsByProvider)
      })
      .catch(() => {
        if (!cancelled) setKnownModels(emptyKnownModelsByProvider)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const effectiveModel = state.touched.chatModelOverride
    ? state.values.chatModelOverride
    : baseline.chatModelOverride
  const provider = effectiveModel?.provider ?? 'openai'
  const model = effectiveModel?.model ?? knownModels[provider]?.[0] ?? ''
  const retrieval = state.touched.retrievalSkillSettings
    ? { ...baseline.retrievalSkillSettings, ...state.values.retrievalSkillSettings }
    : baseline.retrievalSkillSettings

  const setRetrieval = (next: RetrievalSkillSettingsOverride) => {
    dispatch({ type: 'set-retrieval-skill-settings', value: next })
  }

  const toggleRetrievalField = <K extends keyof RetrievalSkillSettingsOverride>(
    field: K,
    enabled: boolean,
    value: RetrievalSkillSettingsOverride[K],
  ) => {
    const next = { ...state.values.retrievalSkillSettings }
    if (enabled) {
      next[field] = value
    } else {
      delete next[field]
    }
    setRetrieval(next)
  }

  const directivesEnabled = state.values.authoredDirectives.length > 0
  const baselineDirectivesEnabled = baseline.authoredDirectives.length > 0
  const directiveLabel = useMemo(
    () => `${baseline.authoredDirectives.length} authored directive${baseline.authoredDirectives.length === 1 ? '' : 's'}`,
    [baseline.authoredDirectives.length],
  )

  const content = (
    <div className="space-y-5 p-4">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
          <div>
            <h2 className="text-sm font-semibold text-foreground">Replay overrides</h2>
            <p className="text-xs text-muted-foreground">Only enabled fields are sent with the run.</p>
          </div>
        </div>

        <section className="space-y-3 rounded-lg border border-border p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium text-foreground">Model</h3>
              <p className="text-xs text-muted-foreground">
                Current: {baseline.chatModelOverride ? `${baseline.chatModelOverride.provider}/${baseline.chatModelOverride.model}` : 'workspace default'}
              </p>
            </div>
            <OverrideToggle
              checked={state.touched.chatModelOverride}
              label="Override model"
              onCheckedChange={(checked) => {
                if (checked) {
                  dispatch({ type: 'set-model', value: effectiveModel ? { ...effectiveModel } : { provider, model } })
                } else {
                  dispatch({ type: 'clear-field', field: 'chatModelOverride' })
                }
              }}
            />
          </div>
          <div className="grid gap-2">
            <Select
              value={provider}
              disabled={!state.touched.chatModelOverride}
              onValueChange={(next) => {
                const nextProvider = next as LlmProviderName
                dispatch({
                  type: 'set-model',
                  value: {
                    provider: nextProvider,
                    model: knownModels[nextProvider]?.[0] ?? '',
                  },
                })
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {llmProviderNames.map((name) => (
                  <SelectItem key={name} value={name}>{providerDisplayName[name]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <ModelPicker
              inputId="workbench-model"
              provider={provider}
              knownModelsByProvider={knownModels}
              value={model}
              disabled={!state.touched.chatModelOverride}
              onChange={(next) => dispatch({ type: 'set-model', value: { provider, model: next } })}
              onCommit={(next) => dispatch({ type: 'set-model', value: { provider, model: next } })}
            />
          </div>
        </section>

        <section className="space-y-3 rounded-lg border border-border p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium text-foreground">Custom instruction</h3>
              <p className="text-xs text-muted-foreground">Overrides the agent instruction for this replay.</p>
            </div>
            <OverrideToggle
              checked={state.touched.customInstruction}
              label="Override custom instruction"
              onCheckedChange={(checked) => {
                if (checked) {
                  dispatch({ type: 'set-custom-instruction', value: state.values.customInstruction })
                } else {
                  dispatch({ type: 'clear-field', field: 'customInstruction' })
                }
              }}
            />
          </div>
          <Textarea
            aria-label="Custom instruction override"
            value={state.touched.customInstruction ? state.values.customInstruction : baseline.customInstruction}
            disabled={!state.touched.customInstruction}
            onChange={(event) => dispatch({ type: 'set-custom-instruction', value: event.target.value })}
            rows={5}
          />
        </section>

        <section className="space-y-3 rounded-lg border border-border p-3">
          <div>
            <h3 className="text-sm font-medium text-foreground">Retrieval skill</h3>
            <p className="text-xs text-muted-foreground">Override selected retrieval.answer fields.</p>
          </div>
          <div className="space-y-3">
            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-3">
                <label htmlFor="workbench-top-k" className="text-sm text-foreground">Top K</label>
                <OverrideToggle
                  checked={state.touched.retrievalSkillSettings && Object.prototype.hasOwnProperty.call(state.values.retrievalSkillSettings, 'vectorTopK')}
                  label="Override top K"
                  onCheckedChange={(checked) =>
                    toggleRetrievalField('vectorTopK', checked, numberOrFallback(retrieval.vectorTopK, 8))
                  }
                />
              </div>
              <Input
                id="workbench-top-k"
                type="number"
                min={1}
                max={200}
                disabled={!(state.touched.retrievalSkillSettings && Object.prototype.hasOwnProperty.call(state.values.retrievalSkillSettings, 'vectorTopK'))}
                value={numberOrFallback(retrieval.vectorTopK, 8)}
                onChange={(event) => setRetrieval({ ...state.values.retrievalSkillSettings, vectorTopK: Number(event.target.value) })}
              />
            </div>

            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-3">
                <label className="text-sm text-foreground">Strategy</label>
                <OverrideToggle
                  checked={state.touched.retrievalSkillSettings && Object.prototype.hasOwnProperty.call(state.values.retrievalSkillSettings, 'retrievalStrategy')}
                  label="Override retrieval strategy"
                  onCheckedChange={(checked) =>
                    toggleRetrievalField('retrievalStrategy', checked, retrieval.retrievalStrategy ?? 'auto')
                  }
                />
              </div>
              <Select
                value={retrieval.retrievalStrategy ?? 'auto'}
                disabled={!(state.touched.retrievalSkillSettings && Object.prototype.hasOwnProperty.call(state.values.retrievalSkillSettings, 'retrievalStrategy'))}
                onValueChange={(next) => setRetrieval({ ...state.values.retrievalSkillSettings, retrievalStrategy: next as RetrievalStrategy })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {retrievalStrategies.map((strategy) => (
                    <SelectItem key={strategy} value={strategy}>{strategy}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-3">
                <label htmlFor="workbench-threshold" className="text-sm text-foreground">Threshold</label>
                <OverrideToggle
                  checked={state.touched.retrievalSkillSettings && Object.prototype.hasOwnProperty.call(state.values.retrievalSkillSettings, 'similarityThreshold')}
                  label="Override similarity threshold"
                  onCheckedChange={(checked) =>
                    toggleRetrievalField('similarityThreshold', checked, numberOrFallback(retrieval.similarityThreshold, 0.7))
                  }
                />
              </div>
              <Input
                id="workbench-threshold"
                type="number"
                min={0}
                max={1}
                step={0.01}
                disabled={!(state.touched.retrievalSkillSettings && Object.prototype.hasOwnProperty.call(state.values.retrievalSkillSettings, 'similarityThreshold'))}
                value={numberOrFallback(retrieval.similarityThreshold, 0.7)}
                onChange={(event) => setRetrieval({ ...state.values.retrievalSkillSettings, similarityThreshold: Number(event.target.value) })}
              />
            </div>
          </div>
        </section>

        <section className="space-y-3 rounded-lg border border-border p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium text-foreground">Directives</h3>
              <p className="text-xs text-muted-foreground">{directiveLabel}</p>
            </div>
            <OverrideToggle
              checked={state.touched.authoredDirectives}
              label="Override directives"
              onCheckedChange={(checked) => {
                if (checked) {
                  dispatch({ type: 'set-authored-directives', value: baseline.authoredDirectives })
                } else {
                  dispatch({ type: 'clear-field', field: 'authoredDirectives' })
                }
              }}
            />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/20 px-3 py-2">
            <span className="text-sm text-foreground">Use authored directives</span>
            <Switch
              checked={state.touched.authoredDirectives ? directivesEnabled : baselineDirectivesEnabled}
              disabled={!state.touched.authoredDirectives}
              onCheckedChange={(checked) => {
                dispatch({
                  type: 'set-authored-directives',
                  value: checked ? baseline.authoredDirectives : [],
                })
              }}
            />
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => dispatch({ type: 'reset', baseline })}>
            Reset all overrides
          </Button>
        </section>

        <RoutineStartStateSection
          routines={routines}
          enabled={state.touched.routineStartState}
          value={state.values.routineStartState}
          dispatch={dispatch}
        />
      </div>
  )

  if (variant === 'embedded') {
    return (
      <div className="max-h-[min(70vh,720px)] overflow-y-auto rounded-md border border-border bg-background/50">
        {content}
      </div>
    )
  }

  if (variant === 'drawer') {
    return (
      <div className="rounded-md border border-border bg-background/50">
        {content}
      </div>
    )
  }

  return (
    <aside className="min-h-0 overflow-y-auto border-r border-border bg-background">
      {content}
    </aside>
  )
}
