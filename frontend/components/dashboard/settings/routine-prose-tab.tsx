'use client'

import { useEffect, useMemo, useState } from 'react'

import { RoutineChipEditor, type RoutineEditorVariable } from '@/components/dashboard/settings/routine-chip-editor'
import type { RoutineChipKind } from '@/components/dashboard/settings/routine-chip-node'
import { RoutineCompletionExportPanel } from '@/components/dashboard/settings/routine-completion-export-panel'
import { RoutineTerminalMessages } from '@/components/dashboard/settings/routine-terminal-messages'
import type { RoutineDefinitionDraft } from '@/lib/api'
import type { RoutineCompletionExport, RoutineSlotType, WebhookDestination } from '@/lib/api-types'
import type { RoutineDraftHeader } from '@/lib/routine-form'
import { draftFromChipDoc, readProseCompletionExport, readProseTerminals, routineToChipDoc, type ChipDocVariable, type RoutineDocBlock } from '@/lib/routine-prose'

const DISABLED_COMPLETION_EXPORT: RoutineCompletionExport = { enabled: false, triggerKinds: ['complete'], destinationRef: '' }

// The prose view of the routine editor. It loads an existing routine into inline chips
// (via routineToChipDoc), owns the chip-document state, and emits a draft up whenever the
// document or header changes — so the host screen stays the single owner of save/validate/
// publish. A routine the prose editor can't represent loads as null → the host falls back
// to the Form tab rather than risking a lossy round-trip. Remount (via a `key`) on the
// host re-seeds from a fresh `source` (load, or a switch back from Form).
export function RoutineProseTab({
  source,
  header,
  webhookDestinations,
  isWebhookDestinationsLoading,
  webhookDestinationsError,
  onDraftChange,
  onHeaderChange,
}: {
  source: RoutineDefinitionDraft
  header: RoutineDraftHeader
  webhookDestinations: WebhookDestination[]
  isWebhookDestinationsLoading: boolean
  webhookDestinationsError: string | null
  onDraftChange: (draft: RoutineDefinitionDraft | null) => void
  // Pasting a whole routine carries its name/trigger; lift them back into the host header.
  onHeaderChange?: (update: (header: RoutineDraftHeader) => RoutineDraftHeader) => void
}) {
  const loaded = useMemo(() => routineToChipDoc(source), [source])
  const [variables, setVariables] = useState<ChipDocVariable[]>(loaded?.variables ?? [])
  const [blocks, setBlocks] = useState<RoutineDocBlock[]>([])

  // The complete/handoff terminal ids + messages are preserved outside the chip body. Seed
  // them from the loaded routine so a custom id or message round-trips; the message inputs
  // edit the copy, the ids ride along untouched.
  const initialTerminals = useMemo(() => readProseTerminals(source), [source])
  const [completionMessage, setCompletionMessage] = useState(initialTerminals.complete.instruction ?? '')
  const [handoffMessage, setHandoffMessage] = useState(initialTerminals.handoff?.instruction ?? '')

  // Completion export is routine-level config the body doesn't encode; seed it from the loaded
  // routine and edit it in the panel below the editor.
  const [completionExport, setCompletionExport] = useState<RoutineCompletionExport>(
    () => readProseCompletionExport(source) ?? DISABLED_COMPLETION_EXPORT,
  )

  // The handoff message only applies when the routine actually hands off — show its input
  // when a handoff branch exists in the body or the loaded routine already had one.
  const usesHandoff = blocks.some((block) => block.chips.some((chip) => chip.kind === 'handoff')) || Boolean(initialTerminals.handoff)

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
      terminals: {
        complete: { id: initialTerminals.complete.id, instruction: completionMessage },
        handoff: { id: initialTerminals.handoff?.id, instruction: handoffMessage },
      },
      completionExport,
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
  }, [loaded, blocks, variables, header, initialTerminals, completionMessage, handoffMessage, completionExport, onDraftChange])

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
        name={header.name}
        trigger={header.activation.triggerDescription}
        onCreateVariable={addVariable}
        onDocChange={setBlocks}
        onSetVariableType={setVariableType}
        onSetVariableRequired={setVariableRequired}
        onSetVariableMutable={setVariableMutable}
        onPasteFrontmatter={({ name: pastedName, trigger: pastedTrigger }) => {
          if (!onHeaderChange) return
          onHeaderChange((current) => ({
            ...current,
            ...(pastedName !== null ? { name: pastedName } : {}),
            activation: {
              ...current.activation,
              ...(pastedTrigger !== null ? { triggerDescription: pastedTrigger } : {}),
            },
          }))
        }}
      />
      <p className="text-xs text-muted-foreground">
        Type <kbd className="rounded border border-border px-1">@</kbd> or use the toolbar to insert a variable. Click a chip to set its type.
      </p>
      <RoutineTerminalMessages
        idPrefix="routineProseTab"
        completionMessage={completionMessage}
        onCompletionMessageChange={setCompletionMessage}
        handoffMessage={handoffMessage}
        onHandoffMessageChange={setHandoffMessage}
        showHandoff={usesHandoff}
      />
      <RoutineCompletionExportPanel
        idPrefix="routineProseTab"
        value={completionExport}
        onChange={setCompletionExport}
        webhookDestinations={webhookDestinations}
        isLoading={isWebhookDestinationsLoading}
        error={webhookDestinationsError}
      />
    </div>
  )
}
