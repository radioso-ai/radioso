'use client'

import { Plus, Trash2 } from 'lucide-react'

import type { RoutineEditorVariable } from '@/components/dashboard/settings/routine-chip-editor'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { SkillAuthoringOutput } from '@/lib/api-routine-skill-catalog'
import type { RoutineSlotType } from '@/lib/api-types'
import { nextUnassignedOutput, outputVariableType, variablesFittingOutput } from '@/lib/routine-skill-outputs'
import { slugifyVariableKey } from '@/lib/routine-prose'

// The "Sets" editor of a skill step: which skill output lands in which routine variable. A skill
// that declares outputs offers them by name, and a variable made from one takes its type, so the
// checks a guard offers on it fit. Without declared outputs the output name is typed.
export function BindingAssignments({ assignments, outputs = [], variables = [], onChange, onCreateVariable }: {
  assignments: Record<string, string>
  outputs?: readonly SkillAuthoringOutput[]
  variables?: ReadonlyArray<{ id: string; type: RoutineSlotType }>
  onChange: (assignments: Record<string, string>) => void
  onCreateVariable: (variable: RoutineEditorVariable) => void
}) {
  const entries = Object.entries(assignments)
  const declared = (name: string) => outputs.find((output) => output.name === name)
  const update = (index: number, key: string, value: string) => {
    const next = Object.fromEntries(entries.filter((_, candidate) => candidate !== index))
    const normalized = value.trim() ? slugifyVariableKey(value) : ''
    if (key.trim()) next[key.trim()] = normalized
    onChange(next)
    const output = declared(key.trim())
    if (value.trim()) onCreateVariable({ id: normalized, name: value.trim(), ...(output ? { type: outputVariableType(output) } : {}) })
  }
  const addOutput = () => {
    const output = nextUnassignedOutput(outputs, assignments)
    if (!output) {
      onChange({ ...assignments, [`output_${entries.length + 1}`]: '' })
      return
    }
    // A declared output lands in a variable of its own name at once, so the routine never holds
    // an assignment with no variable.
    const variableId = slugifyVariableKey(output.name)
    onChange({ ...assignments, [output.name]: variableId })
    onCreateVariable({ id: variableId, name: output.name, type: outputVariableType(output) })
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="font-medium">Sets</span>
        <Button type="button" size="sm" variant="ghost" onClick={addOutput}>
          <Plus className="mr-1 h-3.5 w-3.5" />Output
        </Button>
      </div>
      {entries.map(([output, variable], index) => {
        const fitting = variablesFittingOutput(variables, declared(output))
        return (
          <div key={`${output}-${index}`} className="grid grid-cols-[1fr_1fr_auto] gap-2">
            {outputs.length > 0 ? (
              <select
                aria-label={`Output ${index + 1} name`}
                value={output}
                onChange={(event) => update(index, event.target.value, variable)}
                className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
              >
                {declared(output) ? null : <option value={output}>{output}</option>}
                {outputs.map((candidate) => (
                  <option key={candidate.name} value={candidate.name}>{`${candidate.name} (${candidate.type})`}</option>
                ))}
              </select>
            ) : (
              <Input aria-label={`Output ${index + 1} name`} value={output} onChange={(event) => update(index, event.target.value, variable)} placeholder="Output" />
            )}
            <Input
              aria-label={`Output ${index + 1} variable`}
              list={`assignment-variables-${index}`}
              value={variable}
              onChange={(event) => update(index, output, event.target.value)}
              placeholder="Existing or new variable"
            />
            <datalist id={`assignment-variables-${index}`}>
              {fitting.map((candidate) => <option key={candidate.id} value={candidate.id} />)}
            </datalist>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={`Remove output ${index + 1}`}
              onClick={() => onChange(Object.fromEntries(entries.filter((_, candidate) => candidate !== index)))}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        )
      })}
    </div>
  )
}
