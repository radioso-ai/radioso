'use client'

import { useEffect, useMemo, useState } from 'react'

import { RoutineChipEditor, type RoutineEditorVariable } from '@/components/dashboard/settings/routine-chip-editor'
import type { RoutineChipKind } from '@/components/dashboard/settings/routine-chip-node'
import type { RoutineDefinitionDraft } from '@/lib/api'
import type { RoutineSlotType } from '@/lib/api-types'
import type { RoutineDraftHeader } from '@/lib/routine-form'
import { draftFromChipDoc, routineToChipDoc, type ChipDocVariable, type RoutineDocBlock } from '@/lib/routine-prose'

// The prose view of the routine editor. It loads an existing routine into inline chips
// (via routineToChipDoc), owns the chip-document state, and emits a draft up whenever the
// document or header changes — so the host screen stays the single owner of save/validate/
// publish. A routine the prose editor can't represent loads as null → the host falls back
// to the Form tab rather than risking a lossy round-trip. Remount (via a `key`) on the
// host re-seeds from a fresh `source` (load, or a switch back from Form).
export function RoutineProseTab({
  source,
  header,
  onDraftChange,
}: {
  source: RoutineDefinitionDraft
  header: RoutineDraftHeader
  onDraftChange: (draft: RoutineDefinitionDraft | null) => void
}) {
  const loaded = useMemo(() => routineToChipDoc(source), [source])
  const [variables, setVariables] = useState<ChipDocVariable[]>(loaded?.variables ?? [])
  const [blocks, setBlocks] = useState<RoutineDocBlock[]>([])

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

  // Re-derive the draft from the chip document + the host's header on every edit. The host
  // passes a stable onDraftChange (a state setter) so this doesn't loop.
  useEffect(() => {
    if (!loaded) {
      onDraftChange(null)
      return
    }
    const draft = draftFromChipDoc({
      name: header.name,
      trigger: header.activation.triggerDescription,
      blocks,
      variables,
    })
    onDraftChange({
      ...draft,
      // priority and reentryMode are header fields the prose body does not encode; carry
      // them back from the header so switching to Prose and saving does not reset them.
      activation: {
        ...draft.activation,
        priority: Number.parseInt(header.activation.priority, 10) || 0,
        reentryMode: header.activation.reentryMode,
      },
    })
  }, [loaded, blocks, variables, header, onDraftChange])

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

  if (!loaded) {
    return (
      <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
        This routine uses advanced steps the prose editor can’t show yet — edit it in the <strong>Form</strong> tab.
      </p>
    )
  }

  return (
    <div className="space-y-1.5">
      <RoutineChipEditor
        variables={variables}
        reservedRefKinds={reservedRefKinds}
        initialContent={loaded.paragraphs}
        onCreateVariable={addVariable}
        onDocChange={setBlocks}
        onSetVariableType={setVariableType}
      />
      <p className="text-xs text-muted-foreground">
        Type <kbd className="rounded border border-border px-1">@</kbd> or use the toolbar to insert a variable. Click a chip to set its type.
      </p>
    </div>
  )
}
