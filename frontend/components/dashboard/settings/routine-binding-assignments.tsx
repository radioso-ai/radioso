'use client'

import { Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { SkillAuthoringOutput } from '@/lib/api-routine-skill-catalog'

// The "Sets" editor of a skill step: which skill output lands in which routine variable. A skill
// that declares outputs offers them by name; without declared outputs the output name is typed.
// The row is the variable's declaration and its type is the output's, so the editor never makes
// a collected field for it (see routine-output-assignments).
export function BindingAssignments({ assignments, outputs = [], onAdd, onChangeOutput, onChangeVariable, onRemove }: {
  assignments: Record<string, string>
  outputs?: readonly SkillAuthoringOutput[]
  onAdd: () => void
  onChangeOutput: (index: number, output: string) => void
  onChangeVariable: (index: number, variable: string) => void
  onRemove: (index: number) => void
}) {
  const entries = Object.entries(assignments)
  const declared = (name: string) => outputs.find((output) => output.name === name)
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="font-medium">Sets</span>
        <Button type="button" size="sm" variant="ghost" onClick={onAdd}>
          <Plus className="mr-1 h-3.5 w-3.5" />Output
        </Button>
      </div>
      {entries.map(([output, variable], index) => (
        <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2">
          {outputs.length > 0 ? (
            <select
              aria-label={`Output ${index + 1} name`}
              value={output}
              onChange={(event) => onChangeOutput(index, event.target.value)}
              className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
            >
              {declared(output) ? null : <option value={output}>{output}</option>}
              {outputs.map((candidate) => (
                // Another row already reads this output; picking it here would merge the rows.
                <option key={candidate.name} value={candidate.name} disabled={candidate.name !== output && candidate.name in assignments}>
                  {`${candidate.name} (${candidate.type})`}
                </option>
              ))}
            </select>
          ) : (
            <Input aria-label={`Output ${index + 1} name`} value={output} onChange={(event) => onChangeOutput(index, event.target.value)} placeholder="Output" />
          )}
          <Input
            aria-label={`Output ${index + 1} variable`}
            value={variable}
            onChange={(event) => onChangeVariable(index, event.target.value)}
            placeholder="New variable"
          />
          <Button type="button" size="sm" variant="ghost" aria-label={`Remove output ${index + 1}`} onClick={() => onRemove(index)}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
    </div>
  )
}
