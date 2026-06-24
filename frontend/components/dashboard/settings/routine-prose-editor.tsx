'use client'

import { useMemo, useState } from 'react'
import { ArrowLeft, Route } from 'lucide-react'

import { RoutineChipEditor, type RoutineEditorVariable } from '@/components/dashboard/settings/routine-chip-editor'
import type { RoutineChipKind } from '@/components/dashboard/settings/routine-chip-node'
import { RoutineSkillCatalogProvider } from '@/components/dashboard/settings/routine-skill-catalog-popover'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { getApiErrorMessage } from '@/lib/api-error'
import { routinesApi, type RoutineDefinition } from '@/lib/api'
import type { RoutineSlotType } from '@/lib/api-types'
import { draftFromChipDoc, type ChipDocVariable, type RoutineDocBlock } from '@/lib/routine-prose'

export function RoutineProseEditor({
  agentId,
  onClose,
  onCreated,
}: {
  agentId: string
  onClose: () => void
  onCreated: (routine: RoutineDefinition) => void
}) {
  const [name, setName] = useState('')
  const [trigger, setTrigger] = useState('')
  const [variables, setVariables] = useState<ChipDocVariable[]>([])
  const [blocks, setBlocks] = useState<RoutineDocBlock[]>([])
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const addVariable = (variable: RoutineEditorVariable) => {
    setVariables((current) =>
      current.some((existing) => existing.id === variable.id)
        ? current
        : [...current, { id: variable.id, name: variable.name, type: 'text' }],
    )
  }

  const setVariableType = (id: string, type: RoutineSlotType) => {
    setVariables((current) => current.map((variable) => (variable.id === id ? { ...variable, type } : variable)))
  }

  const setVariableRequired = (id: string, required: boolean) => {
    setVariables((current) => current.map((variable) => (variable.id === id ? { ...variable, required } : variable)))
  }

  const setVariableMutable = (id: string, mutable: boolean) => {
    setVariables((current) => current.map((variable) => (variable.id === id ? { ...variable, mutable } : variable)))
  }

  // Names already taken by a chip in the document, so the @ menu won't let a
  // second kind claim the same name.
  const reservedRefKinds = useMemo(() => {
    const reserved: Record<string, RoutineChipKind> = {}
    for (const block of blocks) {
      for (const chip of block.chips) {
        if (chip.kind === 'variable' || chip.kind === 'skill' || chip.kind === 'handoff') {
          reserved[chip.refId] = chip.kind
        }
      }
    }
    return reserved
  }, [blocks])

  const hasContent = blocks.some((block) => block.text.trim().length > 0)

  const save = async () => {
    if (!hasContent) return
    setIsSaving(true)
    setError(null)
    try {
      const draft = draftFromChipDoc({ name, trigger, blocks, variables })
      const response = await routinesApi.createRoutine(agentId, draft)
      onCreated(response.routine)
    } catch (saveError) {
      setError(getApiErrorMessage(saveError, 'Could not save the routine.'))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <SettingsCard
      id="routine-prose-editor-card"
      icon={<Route className="h-5 w-5 text-primary" />}
      title="Write a routine in plain language"
      description="Describe the routine the way you'd explain it to a teammate, and insert variables as chips — no formatting symbols."
      headerEnd={(
        <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="Back to routines">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
      )}
    >
      <RoutineSkillCatalogProvider agentId={agentId}>
        <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="routineProseName">Name</Label>
          <Input
            id="routineProseName"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Process a refund request"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="routineProseTrigger">Trigger</Label>
          <Input
            id="routineProseTrigger"
            value={trigger}
            onChange={(event) => setTrigger(event.target.value)}
            placeholder="When a customer wants a refund or to dispute a charge"
          />
        </div>
        <div className="space-y-1.5">
          <Label>Routine</Label>
          <RoutineChipEditor
            variables={variables}
            reservedRefKinds={reservedRefKinds}
            name={name}
            trigger={trigger}
            onCreateVariable={addVariable}
            onDocChange={setBlocks}
            onSetVariableType={setVariableType}
            onSetVariableRequired={setVariableRequired}
            onSetVariableMutable={setVariableMutable}
            onPasteFrontmatter={({ name: pastedName, trigger: pastedTrigger }) => {
              if (pastedName !== null) setName(pastedName)
              if (pastedTrigger !== null) setTrigger(pastedTrigger)
            }}
          />
          <p className="text-xs text-muted-foreground">
            Type <kbd className="rounded border border-border px-1">@</kbd> or use the toolbar to insert a variable. Click a chip to set its type.
          </p>
        </div>

        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}

        <div className="flex items-center gap-2">
          <Button type="button" onClick={() => void save()} disabled={!hasContent || isSaving}>
            {isSaving ? <Spinner className="mr-2 h-4 w-4" /> : null}
            {isSaving ? 'Saving…' : 'Save routine'}
          </Button>
        </div>
        </div>
      </RoutineSkillCatalogProvider>
    </SettingsCard>
  )
}
