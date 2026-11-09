import type { RoutineDefinition, RoutineDefinitionDraft } from '@/lib/api'
import type { RoutineDraftHeader, RoutineFormState } from '@/lib/routine-form'

// The routine editor keeps name, enablement, and activation in a header beside the Document and
// Form views. These helpers move a draft in and out of that header, and decide who wins when the
// Document view emits a draft: it owns an activation field only if that edit changed it.

export const draftAsRoutine = (draft: RoutineDefinitionDraft, routine?: RoutineDefinition | null): RoutineDefinition => ({
  ...draft,
  id: routine?.id ?? 'local-draft',
  lineageId: routine?.lineageId ?? 'local-lineage',
  agentId: routine?.agentId ?? 'local-agent',
  version: routine?.version ?? 1,
  enabled: draft.enabled ?? routine?.enabled ?? true,
  createdAt: routine?.createdAt ?? new Date(0).toISOString(),
  updatedAt: routine?.updatedAt ?? new Date(0).toISOString(),
})

export const headerFromDraft = (draft: RoutineDefinitionDraft | RoutineDefinition | RoutineFormState): RoutineDraftHeader => ({
  name: draft.name,
  enabled: draft.enabled ?? true,
  activation: {
    triggerDescription: draft.activation.triggerDescription,
    priority: String(draft.activation.priority),
    reentryMode: draft.activation.reentryMode ?? 'once_per_conversation',
    startMode: draft.activation.startMode ?? 'automatic',
    coverageCriteria: draft.activation.coverageCriteria,
  },
})

export const draftWithHeader = (draft: RoutineDefinitionDraft, header: RoutineDraftHeader): RoutineDefinitionDraft => ({
  ...draft,
  name: header.name.trim(),
  enabled: header.enabled,
  activation: {
    ...draft.activation,
    triggerDescription: header.activation.triggerDescription.trim(),
    priority: Number.parseInt(header.activation.priority, 10) || 0,
    reentryMode: header.activation.reentryMode,
    startMode: header.activation.startMode,
    coverageCriteria: header.activation.coverageCriteria,
  },
})

export const mergeDocumentHeaderChange = (
  nextDraft: RoutineDefinitionDraft,
  previousDraft: RoutineDefinitionDraft | null,
  currentHeader: RoutineDraftHeader,
): RoutineDefinitionDraft => {
  // Before the first emit the document was seeded from the current header state, so the
  // header itself is the baseline; using the emitted draft as its own baseline would make
  // the first edit undetectable and revert it.
  const previousHeader = previousDraft ? headerFromDraft(previousDraft) : currentHeader
  const nextHeader = headerFromDraft(nextDraft)
  return draftWithHeader(nextDraft, {
    // The document has no name editor, so the header always owns the name; comparing the
    // doc-emitted name would wipe a typed name with the seed's empty string. Enabled state is
    // never part of the document's own content either, so it always carries forward untouched.
    name: currentHeader.name,
    enabled: currentHeader.enabled,
    activation: {
      triggerDescription: nextHeader.activation.triggerDescription !== previousHeader.activation.triggerDescription
        ? nextHeader.activation.triggerDescription
        : currentHeader.activation.triggerDescription,
      priority: nextHeader.activation.priority !== previousHeader.activation.priority
        ? nextHeader.activation.priority
        : currentHeader.activation.priority,
      reentryMode: nextHeader.activation.reentryMode !== previousHeader.activation.reentryMode
        ? nextHeader.activation.reentryMode
        : currentHeader.activation.reentryMode,
      startMode: nextHeader.activation.startMode !== previousHeader.activation.startMode
        ? nextHeader.activation.startMode
        : currentHeader.activation.startMode,
      coverageCriteria: nextHeader.activation.coverageCriteria,
    },
  })
}
