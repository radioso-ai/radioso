'use client'

import { useMemo, useRef } from 'react'
import { Plus, Trash2, Webhook } from 'lucide-react'

import { RoutineDiagnosticList, RoutineVariableInsertButton } from '@/components/dashboard/settings/routine-editor-controls'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type {
  RoutineGuardKind,
  RoutineSlotType,
  RoutineTerminalKind,
  RoutineValidationDiagnostic,
  WebhookDestination,
} from '@/lib/api'
import {
  customerEmailSkillOutcomeLabels,
  getCustomerEmailRoutineOutcomeOptions,
} from '@/lib/customer-email-skills'
import type { CustomerEmailSkillDefinition, CustomerEmailSkillOutcome } from '@/lib/api-customer-email'
import {
  buildCompletionExportPayloadPreview,
  createSlotForm,
  createStepForm,
  createTerminalForm,
  createTransitionForm,
  diagnosticsForTarget,
  type RoutineFormState,
} from '@/lib/routine-form'

const slotTypes: RoutineSlotType[] = ['text', 'number', 'boolean', 'email', 'date']
const guardKinds: RoutineGuardKind[] = ['llm', 'slot_filled', 'outcome', 'counter', 'default']
const stepKinds: Array<'chat' | 'tool' | 'action'> = ['chat', 'tool', 'action']
const terminalKinds: RoutineTerminalKind[] = ['complete', 'handoff']

const optionLabel = (value: string) => value.replace(/_/gu, ' ')

export function RoutineFormEditor({
  form,
  diagnostics,
  isPublished,
  slotKeys,
  webhookDestinations,
  isWebhookDestinationsLoading,
  webhookDestinationsError,
  emailSkills,
  onChange,
}: {
  form: RoutineFormState
  diagnostics: RoutineValidationDiagnostic[]
  isPublished: boolean
  slotKeys: string[]
  webhookDestinations: WebhookDestination[]
  isWebhookDestinationsLoading: boolean
  webhookDestinationsError: string | null
  emailSkills: CustomerEmailSkillDefinition[]
  onChange: (updater: (current: RoutineFormState) => RoutineFormState) => void
}) {
  const instructionRefs = useRef<Record<string, HTMLTextAreaElement | null>>({})
  const completionExportPayloadPreview = useMemo(
    () => buildCompletionExportPayloadPreview(form),
    [form],
  )

  const insertVariable = (stepId: string, token: string) => {
    const textarea = instructionRefs.current[stepId]
    onChange((current) => ({
      ...current,
      steps: current.steps.map((step) => {
        if (step.stableStepId !== stepId) return step
        const start = textarea?.selectionStart ?? step.instruction.length
        const end = textarea?.selectionEnd ?? step.instruction.length
        return {
          ...step,
          instruction: `${step.instruction.slice(0, start)}${token}${step.instruction.slice(end)}`,
        }
      }),
    }))
  }

  const toggleCompletionExportTrigger = (kind: RoutineTerminalKind, checked: boolean) => {
    onChange((current) => {
      const triggerKinds = checked
        ? [...new Set([...current.completionExport.triggerKinds, kind])]
        : current.completionExport.triggerKinds.filter((item) => item !== kind)
      return {
        ...current,
        completionExport: {
          ...current.completionExport,
          triggerKinds,
        },
      }
    })
  }

  return (
    <>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-sm font-semibold text-foreground">Slots</h4>
          <Button type="button" size="sm" variant="outline" disabled={isPublished} onClick={() => onChange((current) => ({
            ...current,
            slots: [...current.slots, createSlotForm(current.slots.length)],
          }))}>
            <Plus className="mr-2 h-4 w-4" />
            Add slot
          </Button>
        </div>
        {form.slots.map((slot, index) => (
          <div key={slot.stableSlotId} className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-[140px_130px_1fr_auto]">
            <Input aria-label={`Slot ${index + 1} key`} value={slot.key} disabled={isPublished} onChange={(event) => onChange((current) => ({
              ...current,
              slots: current.slots.map((item, itemIndex) => itemIndex === index ? { ...item, key: event.target.value, stableSlotId: event.target.value || item.stableSlotId } : item),
            }))} />
            <Select value={slot.type} disabled={isPublished} onValueChange={(value) => onChange((current) => ({
              ...current,
              slots: current.slots.map((item, itemIndex) => itemIndex === index ? { ...item, type: value as RoutineSlotType } : item),
            }))}>
              <SelectTrigger aria-label={`Slot ${index + 1} type`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {slotTypes.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input aria-label={`Slot ${index + 1} description`} value={slot.description} disabled={isPublished} onChange={(event) => onChange((current) => ({
              ...current,
              slots: current.slots.map((item, itemIndex) => itemIndex === index ? { ...item, description: event.target.value } : item),
            }))} />
            <div className="flex items-center gap-2">
              <Label htmlFor={`slotRequired${index}`} className="text-xs">Required</Label>
              <Switch id={`slotRequired${index}`} checked={slot.required} disabled={isPublished} onCheckedChange={(checked) => onChange((current) => ({
                ...current,
                slots: current.slots.map((item, itemIndex) => itemIndex === index ? { ...item, required: checked } : item),
              }))} />
              <Button type="button" variant="ghost" size="sm" disabled={isPublished} onClick={() => onChange((current) => ({
                ...current,
                slots: current.slots.filter((_, itemIndex) => itemIndex !== index),
              }))} aria-label={`Remove slot ${slot.key || index + 1}`}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            <div className="sm:col-span-4">
              <RoutineDiagnosticList diagnostics={diagnosticsForTarget(diagnostics, { scope: 'slot', id: slot.key })} />
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-sm font-semibold text-foreground">Steps</h4>
          <Button type="button" size="sm" variant="outline" disabled={isPublished} onClick={() => onChange((current) => ({
            ...current,
            steps: [...current.steps, createStepForm(current.steps.length)],
          }))}>
            <Plus className="mr-2 h-4 w-4" />
            Add step
          </Button>
        </div>
        {form.steps.map((step, stepIndex) => (
          <div key={step.stableStepId} className="space-y-3 rounded-lg border border-border p-3">
            <div className="grid gap-3 sm:grid-cols-[160px_130px_1fr_auto]">
              <Input aria-label={`Step ${stepIndex + 1} id`} value={step.stableStepId} disabled={isPublished} onChange={(event) => onChange((current) => ({
                ...current,
                steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? { ...item, stableStepId: event.target.value } : item),
              }))} />
              <Select value={step.kind} disabled={isPublished} onValueChange={(value) => onChange((current) => ({
                ...current,
                steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? { ...item, kind: value as 'chat' | 'tool' | 'action' } : item),
              }))}>
                <SelectTrigger aria-label={`Step ${stepIndex + 1} kind`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {stepKinds.map((kind) => <SelectItem key={kind} value={kind}>{kind}</SelectItem>)}
                </SelectContent>
              </Select>
              {step.kind === 'tool' ? (
                <Input aria-label={`Step ${stepIndex + 1} tool reference`} value={step.toolRef} disabled={isPublished} onChange={(event) => onChange((current) => ({
                  ...current,
                  steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? { ...item, toolRef: event.target.value } : item),
                }))} />
              ) : step.kind === 'action' ? (
                <Input aria-label={`Step ${stepIndex + 1} action type`} value={step.actionType} disabled={isPublished} onChange={(event) => onChange((current) => ({
                  ...current,
                  steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? { ...item, actionType: event.target.value } : item),
                }))} />
              ) : <div />}
              <Button type="button" variant="ghost" size="sm" disabled={isPublished} onClick={() => onChange((current) => ({
                ...current,
                steps: current.steps.filter((_, itemIndex) => itemIndex !== stepIndex),
              }))} aria-label={`Remove step ${step.stableStepId}`}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label htmlFor={`stepInstruction${stepIndex}`}>Instruction</Label>
                <RoutineVariableInsertButton
                  slotKeys={slotKeys}
                  ariaLabel={`Insert variable into step ${stepIndex + 1}`}
                  onInsert={(token) => insertVariable(step.stableStepId, token)}
                />
              </div>
              <Textarea
                id={`stepInstruction${stepIndex}`}
                aria-label={`Step ${stepIndex + 1} instruction`}
                ref={(element) => { instructionRefs.current[step.stableStepId] = element }}
                value={step.instruction}
                disabled={isPublished}
                onChange={(event) => onChange((current) => ({
                  ...current,
                  steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? { ...item, instruction: event.target.value } : item),
                }))}
                rows={3}
              />
            </div>
            <RoutineDiagnosticList diagnostics={diagnosticsForTarget(diagnostics, { scope: 'step', id: step.stableStepId })} />

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-medium uppercase text-muted-foreground">Transitions</p>
                <Button type="button" size="sm" variant="outline" disabled={isPublished} onClick={() => onChange((current) => ({
                  ...current,
                  steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? {
                    ...item,
                    transitions: [...item.transitions, createTransitionForm(item.stableStepId, current.terminals[0]?.stableStepId ?? '')],
                  } : item),
                }))}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add transition
                </Button>
              </div>
              {step.transitions.map((transition, transitionIndex) => {
                const emailSkill = step.kind === 'tool'
                  ? emailSkills.find((skill) => skill.enabled && skill.skillName === step.toolRef.trim())
                  : undefined
                const emailOutcomeOptions = getCustomerEmailRoutineOutcomeOptions(emailSkill?.outcomes)
                return (
                <div key={`${transition.fromStep}-${transitionIndex}`} className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-[150px_140px_1fr_auto]">
                  <Select value={transition.toRef} disabled={isPublished} onValueChange={(value) => onChange((current) => ({
                    ...current,
                    steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? {
                      ...item,
                      transitions: item.transitions.map((candidate, candidateIndex) => candidateIndex === transitionIndex ? { ...candidate, toRef: value } : candidate),
                    } : item),
                  }))}>
                    <SelectTrigger aria-label={`Transition ${transitionIndex + 1} target`}>
                      <SelectValue placeholder="Target" />
                    </SelectTrigger>
                    <SelectContent>
                      {[...form.steps.map((candidate) => candidate.stableStepId), ...form.terminals.map((candidate) => candidate.stableStepId)].map((id) => (
                        <SelectItem key={id} value={id}>{id}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={transition.guardKind} disabled={isPublished} onValueChange={(value) => onChange((current) => ({
                    ...current,
                    steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? {
                      ...item,
                      transitions: item.transitions.map((candidate, candidateIndex) => candidateIndex === transitionIndex ? { ...candidate, guardKind: value as RoutineGuardKind } : candidate),
                    } : item),
                  }))}>
                    <SelectTrigger aria-label={`Transition ${transitionIndex + 1} guard`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {guardKinds.map((kind) => <SelectItem key={kind} value={kind}>{optionLabel(kind)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {transition.guardKind === 'outcome' ? (
                    emailSkill ? (
                      <Select value={transition.outcomeStatus} disabled={isPublished} onValueChange={(value) => onChange((current) => ({
                        ...current,
                        steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? {
                          ...item,
                          transitions: item.transitions.map((candidate, candidateIndex) => candidateIndex === transitionIndex ? { ...candidate, outcomeStatus: value } : candidate),
                        } : item),
                      }))}>
                        <SelectTrigger aria-label={`Transition ${transitionIndex + 1} outcome`}>
                          <SelectValue placeholder="Outcome status" />
                        </SelectTrigger>
                        <SelectContent>
                          {emailOutcomeOptions.map((outcome: CustomerEmailSkillOutcome) => (
                            <SelectItem key={outcome} value={outcome}>
                              {customerEmailSkillOutcomeLabels[outcome]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input aria-label={`Transition ${transitionIndex + 1} outcome`} placeholder="Outcome status" value={transition.outcomeStatus} disabled={isPublished} onChange={(event) => onChange((current) => ({
                        ...current,
                        steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? {
                          ...item,
                          transitions: item.transitions.map((candidate, candidateIndex) => candidateIndex === transitionIndex ? { ...candidate, outcomeStatus: event.target.value } : candidate),
                        } : item),
                      }))} />
                    )
                  ) : transition.guardKind === 'counter' ? (
                    <Input aria-label={`Transition ${transitionIndex + 1} counter limit`} type="number" placeholder="Limit" value={transition.counterLimit} disabled={isPublished} onChange={(event) => onChange((current) => ({
                      ...current,
                      steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? {
                        ...item,
                        transitions: item.transitions.map((candidate, candidateIndex) => candidateIndex === transitionIndex ? { ...candidate, counterLimit: event.target.value } : candidate),
                      } : item),
                    }))} />
                  ) : (
                    <Input aria-label={`Transition ${transitionIndex + 1} condition`} placeholder="Guard text" value={transition.guardText} disabled={isPublished} onChange={(event) => onChange((current) => ({
                      ...current,
                      steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? {
                        ...item,
                        transitions: item.transitions.map((candidate, candidateIndex) => candidateIndex === transitionIndex ? { ...candidate, guardText: event.target.value } : candidate),
                      } : item),
                    }))} />
                  )}
                  <Button type="button" variant="ghost" size="sm" disabled={isPublished} onClick={() => onChange((current) => ({
                    ...current,
                    steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? {
                      ...item,
                      transitions: item.transitions.filter((_, candidateIndex) => candidateIndex !== transitionIndex),
                    } : item),
                  }))} aria-label={`Remove transition ${transitionIndex + 1}`}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                  <div className="sm:col-span-4">
                    <RoutineDiagnosticList diagnostics={diagnosticsForTarget(diagnostics, {
                      scope: 'transition',
                      id: `${transition.fromStep}->${transition.toRef}`,
                    })} />
                  </div>
                </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-sm font-semibold text-foreground">Terminals</h4>
          <Button type="button" size="sm" variant="outline" disabled={isPublished} onClick={() => onChange((current) => ({
            ...current,
            terminals: [...current.terminals, createTerminalForm(current.terminals.length)],
          }))}>
            <Plus className="mr-2 h-4 w-4" />
            Add terminal
          </Button>
        </div>
        {form.terminals.map((terminal, index) => (
          <div key={terminal.stableStepId} className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-[160px_140px_1fr_auto]">
            <Input aria-label={`Terminal ${index + 1} id`} value={terminal.stableStepId} disabled={isPublished} onChange={(event) => onChange((current) => ({
              ...current,
              terminals: current.terminals.map((item, itemIndex) => itemIndex === index ? { ...item, stableStepId: event.target.value } : item),
            }))} />
            <Select value={terminal.kind} disabled={isPublished} onValueChange={(value) => onChange((current) => ({
              ...current,
              terminals: current.terminals.map((item, itemIndex) => itemIndex === index ? { ...item, kind: value as RoutineTerminalKind } : item),
            }))}>
              <SelectTrigger aria-label={`Terminal ${index + 1} kind`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {terminalKinds.map((kind) => <SelectItem key={kind} value={kind}>{kind}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input aria-label={`Terminal ${index + 1} instruction`} value={terminal.instruction} disabled={isPublished} onChange={(event) => onChange((current) => ({
              ...current,
              terminals: current.terminals.map((item, itemIndex) => itemIndex === index ? { ...item, instruction: event.target.value } : item),
            }))} />
            <Button type="button" variant="ghost" size="sm" disabled={isPublished} onClick={() => onChange((current) => ({
              ...current,
              terminals: current.terminals.filter((_, itemIndex) => itemIndex !== index),
            }))} aria-label={`Remove terminal ${terminal.stableStepId}`}>
              <Trash2 className="h-4 w-4" />
            </Button>
            <div className="sm:col-span-4">
              <RoutineDiagnosticList diagnostics={diagnosticsForTarget(diagnostics, { scope: 'terminal', id: terminal.stableStepId })} />
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-3 rounded-lg border border-border p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Webhook className="h-4 w-4 text-primary" />
              <h4 className="text-sm font-semibold text-foreground">Completion export</h4>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Send collected slot data to a workspace webhook destination when this routine reaches a matching terminal.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant={form.completionExport.enabled ? 'outline' : 'default'}
            disabled={isPublished}
            onClick={() => onChange((current) => ({
              ...current,
              completionExport: {
                ...current.completionExport,
                enabled: !current.completionExport.enabled,
              },
            }))}
          >
            {form.completionExport.enabled ? 'Disable completion export' : 'Enable completion export'}
          </Button>
        </div>

        {form.completionExport.enabled ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="space-y-3">
              {webhookDestinationsError ? (
                <p className="text-xs text-destructive">{webhookDestinationsError}</p>
              ) : null}
              <div className="space-y-1">
                <Label htmlFor="completionExportDestination">Webhook destination</Label>
                <Select
                  value={form.completionExport.destinationRef}
                  disabled={isPublished || isWebhookDestinationsLoading || webhookDestinations.length === 0}
                  onValueChange={(value) => onChange((current) => ({
                    ...current,
                    completionExport: { ...current.completionExport, destinationRef: value },
                  }))}
                >
                  <SelectTrigger id="completionExportDestination" aria-label="Webhook destination">
                    <SelectValue placeholder={isWebhookDestinationsLoading ? 'Loading destinations...' : 'Select destination'} />
                  </SelectTrigger>
                  <SelectContent>
                    {webhookDestinations.map((destination) => (
                      <SelectItem key={destination.id} value={destination.id}>{destination.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {webhookDestinations.length === 0 && !isWebhookDestinationsLoading ? (
                  <p className="text-xs text-muted-foreground">
                    Create a workspace webhook destination before publishing this export.
                  </p>
                ) : null}
              </div>
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase text-muted-foreground">Terminal triggers</p>
                <div className="flex flex-wrap gap-4">
                  {terminalKinds.map((kind) => (
                    <div key={kind} className="flex items-center gap-2">
                      <Switch
                        id={`completionExportTrigger-${kind}`}
                        checked={form.completionExport.triggerKinds.includes(kind)}
                        disabled={isPublished}
                        onCheckedChange={(checked) => toggleCompletionExportTrigger(kind, checked)}
                      />
                      <Label htmlFor={`completionExportTrigger-${kind}`} className="text-sm">{kind}</Label>
                    </div>
                  ))}
                </div>
              </div>
              <RoutineDiagnosticList diagnostics={diagnosticsForTarget(diagnostics, {
                scope: 'routine',
                id: 'completionExport.destinationRef',
              })} />
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase text-muted-foreground">Payload preview</p>
              <pre className="max-h-72 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs leading-5 text-foreground">
                {JSON.stringify(completionExportPayloadPreview, null, 2)}
              </pre>
            </div>
          </div>
        ) : null}
      </div>
    </>
  )
}
