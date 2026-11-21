'use client'

import { Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import type { ApiRequestMethod } from '@/lib/api-connections'
import { ApiOutputsEditor } from './ApiOutputsEditor'
import { ApiValueTypeSelect } from './ApiValueTypeSelect'
import { ApiRequestTestPanel } from './ApiRequestTestPanel'
import {
  API_REQUEST_METHODS,
  emptyApiFixedParam,
  emptyApiInput,
  type ApiFixedParamDraft,
  type ApiInputDraft,
  type ApiRequestDraft,
} from './api-request-skill-model'

function InputRow({ input, index, onChange, onRemove }: {
  input: ApiInputDraft
  index: number
  onChange: (patch: Partial<ApiInputDraft>) => void
  onRemove: () => void
}) {
  const n = index + 1
  return (
    <div className="space-y-2 p-3">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_minmax(0,1fr)_auto]">
        <Input aria-label={`Input ${n} key`} value={input.key} onChange={(event) => onChange({ key: event.target.value })} placeholder="order_number" />
        <ApiValueTypeSelect value={input.type} label={`Input ${n} type`} onChange={(type) => onChange({ type })} />
        <Input aria-label={`Input ${n} description`} value={input.description} onChange={(event) => onChange({ description: event.target.value })} placeholder="Description shown to the agent" />
        <Button type="button" variant="ghost" size="icon" aria-label={`Remove input ${n}`} onClick={onRemove}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <label className="flex items-center gap-2">
          <Switch checked={input.required} onCheckedChange={(required) => onChange({ required })} aria-label={`Input ${n} required`} />
          Required
        </label>
        <label className="flex items-center gap-2">
          <Switch checked={input.verifiedOnly} onCheckedChange={(verifiedOnly) => onChange({ verifiedOnly })} aria-label={`Input ${n} verified visitors only`} />
          Verified visitors only
        </label>
        <Input
          aria-label={`Input ${n} slot`}
          className="h-8 w-40"
          value={input.slotBinding}
          onChange={(event) => onChange({ slotBinding: event.target.value })}
          placeholder="Slot (optional)"
        />
      </div>
    </div>
  )
}

function FixedParamRow({ param, index, onChange, onRemove }: {
  param: ApiFixedParamDraft
  index: number
  onChange: (patch: Partial<ApiFixedParamDraft>) => void
  onRemove: () => void
}) {
  const n = index + 1
  return (
    <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
      <Input aria-label={`Fixed param ${n} key`} value={param.key} onChange={(event) => onChange({ key: event.target.value })} placeholder="currency" />
      <Input aria-label={`Fixed param ${n} value`} value={param.value} onChange={(event) => onChange({ value: event.target.value })} placeholder="EUR" />
      <Button type="button" variant="ghost" size="icon" aria-label={`Remove fixed param ${n}`} onClick={onRemove}>
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  )
}

function SectionHeading({ title, addLabel, onAdd }: { title: string; addLabel: string; onAdd: () => void }) {
  return (
    <div className="flex items-center justify-between">
      <h4 className="text-sm font-medium text-foreground">{title}</h4>
      <Button type="button" variant="ghost" size="sm" onClick={onAdd}>
        <Plus className="h-4 w-4" />
        {addLabel}
      </Button>
    </div>
  )
}

export function ApiRequestFields({ connectionId, draft, onChange }: {
  connectionId: string
  draft: ApiRequestDraft
  onChange: (draft: ApiRequestDraft) => void
}) {
  const patch = (next: Partial<ApiRequestDraft>) => onChange({ ...draft, ...next })
  const patchInput = (id: string, next: Partial<ApiInputDraft>) =>
    patch({ inputs: draft.inputs.map((input) => (input.id === id ? { ...input, ...next } : input)) })
  const patchFixed = (id: string, next: Partial<ApiFixedParamDraft>) =>
    patch({ fixedParams: draft.fixedParams.map((param) => (param.id === id ? { ...param, ...next } : param)) })

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
        <div className="space-y-2">
          <Label htmlFor="api-request-method">Method</Label>
          <Select value={draft.method} onValueChange={(method) => patch({ method: method as ApiRequestMethod })}>
            <SelectTrigger id="api-request-method"><SelectValue /></SelectTrigger>
            <SelectContent>
              {API_REQUEST_METHODS.map((method) => <SelectItem key={method} value={method}>{method}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="api-request-path">Path</Label>
          <Input id="api-request-path" value={draft.path} onChange={(event) => patch({ path: event.target.value })} placeholder="/orders/{order_number}" />
        </div>
      </div>

      <div className="space-y-2">
        <SectionHeading title="Inputs" addLabel="Input" onAdd={() => patch({ inputs: [...draft.inputs, emptyApiInput()] })} />
        {draft.inputs.length > 0 ? (
          <div className="divide-y divide-border rounded-md border border-border">
            {draft.inputs.map((input, index) => (
              <InputRow
                key={input.id}
                input={input}
                index={index}
                onChange={(next) => patchInput(input.id, next)}
                onRemove={() => patch({ inputs: draft.inputs.filter((candidate) => candidate.id !== input.id) })}
              />
            ))}
          </div>
        ) : null}
      </div>

      <div className="space-y-2">
        <SectionHeading title="Fixed params" addLabel="Param" onAdd={() => patch({ fixedParams: [...draft.fixedParams, emptyApiFixedParam()] })} />
        {draft.fixedParams.map((param, index) => (
          <FixedParamRow
            key={param.id}
            param={param}
            index={index}
            onChange={(next) => patchFixed(param.id, next)}
            onRemove={() => patch({ fixedParams: draft.fixedParams.filter((candidate) => candidate.id !== param.id) })}
          />
        ))}
      </div>

      <ApiOutputsEditor outputs={draft.outputs} onChange={(outputs) => patch({ outputs })} />
      <ApiRequestTestPanel connectionId={connectionId} draft={draft} onAddOutput={(outputs) => patch({ outputs })} />
    </div>
  )
}
