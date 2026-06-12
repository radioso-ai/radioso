'use client'

import { useRef } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2, Wrench } from 'lucide-react'

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
import type { RoutineSlotType, RoutineValidationDiagnostic } from '@/lib/api'
import {
  createOutlineBranch,
  createOutlineEnd,
  createOutlineStep,
  createOutlineVariable,
  diagnosticsForOutlineTarget,
  type RoutineOutlineActionOption,
  type RoutineOutlineState,
  type RoutineOutlineStep,
} from '@/lib/routine-outline'

const slotTypes: RoutineSlotType[] = ['text', 'number', 'boolean', 'email', 'date']

const actionForOutlineStep = (
  step: RoutineOutlineStep,
  actionOptions: RoutineOutlineActionOption[],
): RoutineOutlineActionOption | null =>
  actionOptions.find((option) =>
    step.instruction.includes(`@${option.label}`) || step.instruction.includes(`{{action.${option.ref}}}`),
  ) ?? null

export function RoutineOutlineEditor({
  outline,
  diagnostics,
  isPublished,
  slotKeys,
  actionOptions,
  onChange,
}: {
  outline: RoutineOutlineState
  diagnostics: RoutineValidationDiagnostic[]
  isPublished: boolean
  slotKeys: string[]
  actionOptions: RoutineOutlineActionOption[]
  onChange: (updater: (current: RoutineOutlineState) => RoutineOutlineState) => void
}) {
  const instructionRefs = useRef<Record<string, HTMLTextAreaElement | null>>({})

  const insertToken = (stepId: string, token: string) => {
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

  return (
    <>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-sm font-semibold text-foreground">Variables</h4>
          <Button type="button" size="sm" variant="outline" disabled={isPublished} onClick={() => onChange((current) => ({
            ...current,
            variables: [...current.variables, createOutlineVariable(current.variables.length)],
          }))}>
            <Plus className="mr-2 h-4 w-4" />
            Add variable
          </Button>
        </div>
        {outline.variables.map((variable, index) => (
          <div key={variable.stableSlotId} className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-[140px_130px_1fr_auto]">
            <Input aria-label={`Variable ${index + 1} key`} value={variable.key} disabled={isPublished} onChange={(event) => onChange((current) => ({
              ...current,
              variables: current.variables.map((item, itemIndex) => itemIndex === index ? { ...item, key: event.target.value, stableSlotId: item.stableSlotId.startsWith('slot_') ? event.target.value || item.stableSlotId : item.stableSlotId } : item),
            }))} />
            <Select value={variable.type} disabled={isPublished} onValueChange={(value) => onChange((current) => ({
              ...current,
              variables: current.variables.map((item, itemIndex) => itemIndex === index ? { ...item, type: value as RoutineSlotType } : item),
            }))}>
              <SelectTrigger aria-label={`Variable ${index + 1} type`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {slotTypes.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input aria-label={`Variable ${index + 1} description`} value={variable.description} disabled={isPublished} onChange={(event) => onChange((current) => ({
              ...current,
              variables: current.variables.map((item, itemIndex) => itemIndex === index ? { ...item, description: event.target.value } : item),
            }))} />
            <div className="flex items-center gap-2">
              <Label htmlFor={`outlineVariableRequired${index}`} className="text-xs">Required</Label>
              <Switch id={`outlineVariableRequired${index}`} checked={variable.required} disabled={isPublished} onCheckedChange={(checked) => onChange((current) => ({
                ...current,
                variables: current.variables.map((item, itemIndex) => itemIndex === index ? { ...item, required: checked } : item),
              }))} />
              <Button type="button" variant="ghost" size="sm" disabled={isPublished} onClick={() => onChange((current) => ({
                ...current,
                variables: current.variables.filter((_, itemIndex) => itemIndex !== index),
              }))} aria-label={`Remove variable ${variable.key || index + 1}`}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            <div className="sm:col-span-4">
              <RoutineDiagnosticList diagnostics={diagnosticsForOutlineTarget(diagnostics, { scope: 'variable', id: variable.key })} />
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-sm font-semibold text-foreground">Steps</h4>
          <Button type="button" size="sm" variant="outline" disabled={isPublished} onClick={() => onChange((current) => ({
            ...current,
            steps: [...current.steps, createOutlineStep(current.steps.length)],
          }))}>
            <Plus className="mr-2 h-4 w-4" />
            Add step
          </Button>
        </div>
        {outline.steps.map((step, stepIndex) => (
          <div key={step.stableStepId} className="space-y-3 rounded-lg border border-border p-3">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
              <div className="space-y-1">
                <Label htmlFor={`outlineStepLabel${stepIndex}`}>Step {stepIndex + 1} label</Label>
                <Input id={`outlineStepLabel${stepIndex}`} aria-label={`Outline step ${stepIndex + 1} label`} value={step.label} disabled={isPublished} onChange={(event) => onChange((current) => ({
                  ...current,
                  steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? {
                    ...item,
                    label: event.target.value,
                    stableStepId: item.stableStepId.startsWith('step_') ? event.target.value || item.stableStepId : item.stableStepId,
                  } : item),
                }))} />
              </div>
              <div className="flex items-end gap-1">
                <Button type="button" variant="ghost" size="sm" disabled={isPublished || stepIndex === 0} onClick={() => onChange((current) => {
                  const steps = [...current.steps]
                  const previous = steps[stepIndex - 1]
                  steps[stepIndex - 1] = steps[stepIndex]!
                  steps[stepIndex] = previous!
                  return { ...current, steps }
                })} aria-label={`Move step ${stepIndex + 1} up`}>
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button type="button" variant="ghost" size="sm" disabled={isPublished || stepIndex === outline.steps.length - 1} onClick={() => onChange((current) => {
                  const steps = [...current.steps]
                  const next = steps[stepIndex + 1]
                  steps[stepIndex + 1] = steps[stepIndex]!
                  steps[stepIndex] = next!
                  return { ...current, steps }
                })} aria-label={`Move step ${stepIndex + 1} down`}>
                  <ArrowDown className="h-4 w-4" />
                </Button>
                <Button type="button" variant="ghost" size="sm" disabled={isPublished} onClick={() => onChange((current) => ({
                  ...current,
                  steps: current.steps.filter((_, itemIndex) => itemIndex !== stepIndex),
                }))} aria-label={`Remove outline step ${step.label || stepIndex + 1}`}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label htmlFor={`outlineStepInstruction${stepIndex}`}>Instruction</Label>
                <div className="flex flex-wrap gap-2">
                  <RoutineVariableInsertButton
                    slotKeys={slotKeys}
                    ariaLabel={`Insert variable into outline step ${stepIndex + 1}`}
                    onInsert={(token) => insertToken(step.stableStepId, token.replace(/\{\{\s*slot\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/u, '@$1'))}
                  />
                  <Select onValueChange={(ref) => {
                    const action = actionOptions.find((option) => option.ref === ref)
                    if (action) insertToken(step.stableStepId, `@${action.label}`)
                  }}>
                    <SelectTrigger aria-label={`Insert action into outline step ${stepIndex + 1}`} className="h-8 w-[150px]">
                      <Wrench className="mr-2 h-4 w-4" />
                      <SelectValue placeholder="Insert action" />
                    </SelectTrigger>
                    <SelectContent>
                      {actionOptions.map((action) => (
                        <SelectItem key={action.ref} value={action.ref}>{action.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <Textarea
                id={`outlineStepInstruction${stepIndex}`}
                aria-label={`Outline step ${stepIndex + 1} instruction`}
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
            <RoutineDiagnosticList diagnostics={diagnosticsForOutlineTarget(diagnostics, { scope: 'step', id: step.stableStepId })} />

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-medium uppercase text-muted-foreground">Branches</p>
                <Button type="button" size="sm" variant="outline" disabled={isPublished} aria-label={`Add branch to outline step ${stepIndex + 1}`} onClick={() => onChange((current) => ({
                  ...current,
                  steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? {
                    ...item,
                    branches: [...item.branches, createOutlineBranch(item.stableStepId, item.branches.length, current.steps[stepIndex + 1]?.stableStepId ?? current.ends[0]?.stableStepId ?? '')],
                  } : item),
                }))}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add branch
                </Button>
              </div>
              {step.branches.map((branch, branchIndex) => (
                <div key={branch.id} className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-[minmax(0,1fr)_150px_120px_auto]">
                  <Input aria-label={`Outline step ${stepIndex + 1} branch ${branchIndex + 1} condition`} placeholder="Condition" value={branch.condition} disabled={isPublished} onChange={(event) => onChange((current) => ({
                    ...current,
                    steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? {
                      ...item,
                      branches: item.branches.map((candidate, candidateIndex) => candidateIndex === branchIndex ? { ...candidate, condition: event.target.value } : candidate),
                    } : item),
                  }))} />
                  <Select value={branch.targetRef} disabled={isPublished} onValueChange={(value) => onChange((current) => ({
                    ...current,
                    steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? {
                      ...item,
                      branches: item.branches.map((candidate, candidateIndex) => candidateIndex === branchIndex ? { ...candidate, targetRef: value } : candidate),
                    } : item),
                  }))}>
                    <SelectTrigger aria-label={`Outline step ${stepIndex + 1} branch ${branchIndex + 1} target`}>
                      <SelectValue placeholder="Target" />
                    </SelectTrigger>
                    <SelectContent>
                      {[...outline.steps.map((candidate) => ({ value: candidate.stableStepId, label: candidate.label || candidate.stableStepId })), ...outline.ends.map((candidate) => ({ value: candidate.stableStepId, label: candidate.handoff ? `${candidate.label} handoff` : candidate.label }))].map((target) => (
                        <SelectItem key={target.value} value={target.value}>{target.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input aria-label={`Outline step ${stepIndex + 1} branch ${branchIndex + 1} counter limit`} type="number" placeholder="Max N" value={branch.counterLimit} disabled={isPublished} onChange={(event) => onChange((current) => ({
                    ...current,
                    steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? {
                      ...item,
                      branches: item.branches.map((candidate, candidateIndex) => candidateIndex === branchIndex ? { ...candidate, counterLimit: event.target.value } : candidate),
                    } : item),
                  }))} />
                  <Button type="button" variant="ghost" size="sm" disabled={isPublished} onClick={() => onChange((current) => ({
                    ...current,
                    steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? {
                      ...item,
                      branches: item.branches.filter((_, candidateIndex) => candidateIndex !== branchIndex),
                    } : item),
                  }))} aria-label={`Remove outline step ${stepIndex + 1} branch ${branchIndex + 1}`}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                  {actionForOutlineStep(step, actionOptions) ? (
                    <Input aria-label={`Outline step ${stepIndex + 1} branch ${branchIndex + 1} outcome status`} className="sm:col-span-2" placeholder="Outcome status" value={branch.outcomeStatus} disabled={isPublished} onChange={(event) => onChange((current) => ({
                      ...current,
                      steps: current.steps.map((item, itemIndex) => itemIndex === stepIndex ? {
                        ...item,
                        branches: item.branches.map((candidate, candidateIndex) => candidateIndex === branchIndex ? { ...candidate, outcomeStatus: event.target.value } : candidate),
                      } : item),
                    }))} />
                  ) : null}
                  <div className="sm:col-span-4">
                    <RoutineDiagnosticList diagnostics={diagnosticsForOutlineTarget(diagnostics, {
                      scope: 'branch',
                      id: `${step.stableStepId}->${branch.targetRef}`,
                    })} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-sm font-semibold text-foreground">Ends</h4>
          <Button type="button" size="sm" variant="outline" disabled={isPublished} onClick={() => onChange((current) => ({
            ...current,
            ends: [...current.ends, createOutlineEnd(current.ends.length)],
          }))}>
            <Plus className="mr-2 h-4 w-4" />
            Add end
          </Button>
        </div>
        {outline.ends.map((end, index) => (
          <div key={end.stableStepId} className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-[160px_1fr_auto_auto]">
            <Input aria-label={`End ${index + 1} label`} value={end.label} disabled={isPublished} onChange={(event) => onChange((current) => ({
              ...current,
              ends: current.ends.map((item, itemIndex) => itemIndex === index ? {
                ...item,
                label: event.target.value,
                stableStepId: item.stableStepId.startsWith('complete_') ? event.target.value || item.stableStepId : item.stableStepId,
              } : item),
            }))} />
            <Input aria-label={`End ${index + 1} message`} value={end.message} disabled={isPublished} onChange={(event) => onChange((current) => ({
              ...current,
              ends: current.ends.map((item, itemIndex) => itemIndex === index ? { ...item, message: event.target.value } : item),
            }))} />
            <div className="flex items-center gap-2">
              <Label htmlFor={`endHandoff${index}`} className="text-xs">Handoff</Label>
              <Switch id={`endHandoff${index}`} checked={end.handoff} disabled={isPublished} onCheckedChange={(checked) => onChange((current) => ({
                ...current,
                ends: current.ends.map((item, itemIndex) => itemIndex === index ? { ...item, handoff: checked } : item),
              }))} />
            </div>
            <Button type="button" variant="ghost" size="sm" disabled={isPublished} onClick={() => onChange((current) => ({
              ...current,
              ends: current.ends.filter((_, itemIndex) => itemIndex !== index),
            }))} aria-label={`Remove end ${end.label || index + 1}`}>
              <Trash2 className="h-4 w-4" />
            </Button>
            <div className="sm:col-span-4">
              <RoutineDiagnosticList diagnostics={diagnosticsForOutlineTarget(diagnostics, { scope: 'end', id: end.stableStepId })} />
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
