'use client'

import { Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import type { ApiOutputFieldRole } from '@/lib/api-connections'
import { ApiValueTypeSelect } from './ApiValueTypeSelect'
import {
  API_FIELD_ROLES,
  emptyApiOutput,
  emptyApiOutputField,
  fieldTypeAllowsRole,
  MAX_LIST_ITEMS,
  type ApiOutputDraft,
  type ApiOutputFieldDraft,
} from './api-request-skill-model'

const NO_ROLE = '__none'

function FieldRow({ field, label, onChange, onRemove }: {
  field: ApiOutputFieldDraft
  label: string
  onChange: (patch: Partial<ApiOutputFieldDraft>) => void
  onRemove: () => void
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_7rem_7rem_auto]">
      <Input aria-label={`${label} name`} value={field.name} onChange={(event) => onChange({ name: event.target.value })} placeholder="name" />
      <Input aria-label={`${label} path`} value={field.path} onChange={(event) => onChange({ path: event.target.value })} placeholder="path in item" />
      <ApiValueTypeSelect
        value={field.type}
        label={`${label} type`}
        onChange={(type) => onChange({ type, ...(fieldTypeAllowsRole(type, field.role) ? {} : { role: '' as const }) })}
      />
      <Select
        value={field.role || NO_ROLE}
        onValueChange={(role) => onChange({ role: role === NO_ROLE ? '' : role as ApiOutputFieldRole })}
      >
        <SelectTrigger aria-label={`${label} card role`} className="h-9"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_ROLE}>No role</SelectItem>
          {API_FIELD_ROLES.map((role) => (
            <SelectItem key={role} value={role} disabled={!fieldTypeAllowsRole(field.type, role)}>{role}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${label}`} onClick={onRemove}>
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  )
}

function OutputCard({ output, index, onChange, onRemove }: {
  output: ApiOutputDraft
  index: number
  onChange: (patch: Partial<ApiOutputDraft>) => void
  onRemove: () => void
}) {
  const n = index + 1
  const isList = output.kind === 'list'
  const patchField = (id: string, next: Partial<ApiOutputFieldDraft>) =>
    onChange({ fields: output.fields.map((field) => (field.id === id ? { ...field, ...next } : field)) })
  return (
    <div className="space-y-2 p-3">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_7rem_auto_auto]">
        <Input aria-label={`Output ${n} name`} value={output.name} onChange={(event) => onChange({ name: event.target.value })} placeholder="status" />
        <Input aria-label={`Output ${n} path`} value={output.path} onChange={(event) => onChange({ path: event.target.value })} placeholder="order.status" />
        {isList ? (
          <Input
            aria-label={`Output ${n} max items`}
            type="number"
            min={1}
            max={MAX_LIST_ITEMS}
            value={output.maxItems}
            onChange={(event) => onChange({ maxItems: Number(event.target.value) })}
          />
        ) : (
          <ApiValueTypeSelect value={output.type} label={`Output ${n} type`} onChange={(type) => onChange({ type })} />
        )}
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={output.required} onCheckedChange={(required) => onChange({ required })} aria-label={`Output ${n} required`} />
          Required
        </label>
        <Button type="button" variant="ghost" size="icon" aria-label={`Remove output ${n}`} onClick={onRemove}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <Input
        aria-label={`Output ${n} description`}
        value={output.description}
        onChange={(event) => onChange({ description: event.target.value })}
        placeholder="Description shown to the agent"
      />
      {isList ? (
        <div className="space-y-2 border-l border-border pl-3">
          {output.fields.map((field, fieldIndex) => (
            <FieldRow
              key={field.id}
              field={field}
              label={`Output ${n} field ${fieldIndex + 1}`}
              onChange={(next) => patchField(field.id, next)}
              onRemove={() => onChange({ fields: output.fields.filter((candidate) => candidate.id !== field.id) })}
            />
          ))}
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange({ fields: [...output.fields, emptyApiOutputField()] })}>
            <Plus className="h-4 w-4" />
            Field
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export function ApiOutputsEditor({ outputs, onChange }: {
  outputs: ApiOutputDraft[]
  onChange: (outputs: ApiOutputDraft[]) => void
}) {
  const patchOutput = (id: string, next: Partial<ApiOutputDraft>) =>
    onChange(outputs.map((output) => (output.id === id ? { ...output, ...next } : output)))
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-foreground">Outputs</h4>
        <div className="flex gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange([...outputs, emptyApiOutput('scalar')])}>
            <Plus className="h-4 w-4" />
            Output
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange([...outputs, emptyApiOutput('list')])}>
            <Plus className="h-4 w-4" />
            List
          </Button>
        </div>
      </div>
      {outputs.length > 0 ? (
        <div className="divide-y divide-border rounded-md border border-border">
          {outputs.map((output, index) => (
            <OutputCard
              key={output.id}
              output={output}
              index={index}
              onChange={(next) => patchOutput(output.id, next)}
              onRemove={() => onChange(outputs.filter((candidate) => candidate.id !== output.id))}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}
