'use client'

import { useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { RoutineFieldGuardOp, RoutineFieldGuardUnit, RoutineSlotType } from '@/lib/api-types'
import {
  fieldGuardOpLabel,
  fieldGuardOpNeedsUnit,
  fieldGuardOpNeedsValue,
  fieldGuardOpsForType,
  formatConditionLabel,
  ROUTINE_FIELD_GUARD_UNITS,
  ROUTINE_SLOT_TYPES,
  type ChipDocVariable,
  type RoutineFieldGuardValue,
} from '@radioso/routine-document'

// A structured, decided-in-code comparison the author builds in a dialog. Shared by the
// prose toolbar (insert a new check) and a decided-by-AI condition chip (promote it to a
// deterministic check), so both produce the same field-guard shape.
export type ConditionDraft = {
  refId: string
  op: RoutineFieldGuardOp
  label: string
  value: RoutineFieldGuardValue | null
  values: RoutineFieldGuardValue[] | null
  unit: RoutineFieldGuardUnit | null
}

export function ConditionBuilderDialog({
  open,
  onOpenChange,
  variables,
  onConfirm,
  onSetVariableType,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  variables: ChipDocVariable[]
  onConfirm: (condition: ConditionDraft) => void
  onSetVariableType: (refId: string, type: RoutineSlotType) => void
}) {
  const [refId, setRefId] = useState('')
  const [op, setOp] = useState<RoutineFieldGuardOp>('equals')
  const [valueText, setValueText] = useState('')
  const [unit, setUnit] = useState<RoutineFieldGuardUnit>('months')
  const selected = variables.find((variable) => variable.id === refId)
  const ops = selected ? fieldGuardOpsForType(selected.type) : []
  const needsValue = fieldGuardOpNeedsValue(op)
  const needsUnit = fieldGuardOpNeedsUnit(op)

  const reset = () => {
    setRefId('')
    setOp('equals')
    setValueText('')
    setUnit('months')
  }

  const confirm = () => {
    if (!selected) return
    const numeric = needsUnit || selected.type === 'number'
    const coerce = (raw: string): RoutineFieldGuardValue =>
      numeric && raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : raw
    const value = needsValue && op !== 'in' ? coerce(valueText.trim()) : null
    const values = needsValue && op === 'in'
      ? valueText.split(',').map((part) => part.trim()).filter((part) => part !== '').map(coerce)
      : null
    const unitValue = needsUnit ? unit : null
    onConfirm({ refId: selected.id, op, label: formatConditionLabel(selected.name, op, value, values, unitValue), value, values, unit: unitValue })
    reset()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) reset(); onOpenChange(next) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a check</DialogTitle>
          <DialogDescription>Branch on a variable with an exact comparison — decided in code, not by the AI.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="conditionVariable">Variable</Label>
            <select
              id="conditionVariable"
              value={refId}
              onChange={(event) => {
                const next = event.target.value
                setRefId(next)
                const variable = variables.find((candidate) => candidate.id === next)
                if (variable) setOp(fieldGuardOpsForType(variable.type)[0]!)
              }}
              className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
            >
              <option value="">Choose a variable…</option>
              {variables.map((variable) => (
                <option key={variable.id} value={variable.id}>{variable.name}</option>
              ))}
            </select>
          </div>
          {selected ? (
            <div className="space-y-1.5">
              <Label htmlFor="conditionType">Type</Label>
              <select
                id="conditionType"
                value={selected.type}
                onChange={(event) => {
                  const nextType = event.target.value as RoutineSlotType
                  onSetVariableType(selected.id, nextType)
                  setOp(fieldGuardOpsForType(nextType)[0]!)
                }}
                className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
              >
                {ROUTINE_SLOT_TYPES.map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">The type decides which exact checks are available.</p>
            </div>
          ) : null}
          {selected ? (
            <div className="space-y-1.5">
              <Label htmlFor="conditionOp">Check</Label>
              <select
                id="conditionOp"
                value={op}
                onChange={(event) => setOp(event.target.value as RoutineFieldGuardOp)}
                className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
              >
                {ops.map((candidate) => (
                  <option key={candidate} value={candidate}>{fieldGuardOpLabel(candidate)}</option>
                ))}
              </select>
            </div>
          ) : null}
          {selected && needsValue ? (
            <div className="space-y-1.5">
              <Label htmlFor="conditionValue">{op === 'in' ? 'Values (comma-separated)' : needsUnit ? 'Amount' : 'Value'}</Label>
              <Input
                id="conditionValue"
                value={valueText}
                onChange={(event) => setValueText(event.target.value)}
                placeholder={op === 'in' ? 'completed, refunded' : needsUnit ? '6' : 'completed'}
              />
            </div>
          ) : null}
          {selected && needsUnit ? (
            <div className="space-y-1.5">
              <Label htmlFor="conditionUnit">Unit</Label>
              <select
                id="conditionUnit"
                value={unit}
                onChange={(event) => setUnit(event.target.value as RoutineFieldGuardUnit)}
                className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
              >
                {ROUTINE_FIELD_GUARD_UNITS.map((candidate) => (
                  <option key={candidate} value={candidate}>{candidate}</option>
                ))}
              </select>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" onClick={confirm} disabled={!selected || (needsValue && !valueText.trim())}>
            Add check
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
