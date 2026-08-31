'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Pencil, Plus, ScrollText, Trash2 } from 'lucide-react'

import { DirectiveReplacesField } from '@/components/dashboard/settings/directive-replaces-field'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { mentionsSkill, SkillMentionInput, type SkillMentionOption } from '@/components/dashboard/settings/skill-mention-input'
import { CapabilityPicker } from '@/components/dashboard/settings/skills/CapabilityPicker'
import { SkillForm } from '@/components/dashboard/settings/skills/SkillForm'
import { useScopedRowMutations } from '@/components/dashboard/settings/use-scoped-row-mutations'
import { useSettingsSaveStatus } from '@/components/dashboard/settings/use-settings-save-status'
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
import {
  DIRECTIVE_SURFACE_CHOICES,
  directiveSurfacesOverlap,
  directiveSurfaceLabel,
  directiveSurfacesToForm,
  formSurfacesToPayload,
  toggleDirectiveSurface,
  type DirectiveSurface,
} from '@/lib/directive-surfaces'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { getApiErrorMessage } from '@/lib/api-error'
import {
  directivesApi,
  type BuiltInDirective,
  type Directive,
  type DirectiveCoherence,
  type DirectiveCondition,
  type DirectiveCreateRequest,
  type DirectiveUpdateRequest,
} from '@/lib/api'
import {
  agentSkillsApi,
  type AgentSkill,
  type AgentSkillCapabilityId,
  type AgentSkillCreateInput,
  type SkillCapabilityDescriptor,
} from '@/lib/api-skills'
import { normalizeSkillName } from '@/lib/external-skills'
import { cn } from '@/lib/utils'

type DirectiveFormState = {
  name: string
  conditionKind: DirectiveCondition['kind']
  conditionDescription: string
  // Named `action` because that is the API field; the dialog labels it Instruction.
  action: string
  // The skills the Instruction field carries as chips, exactly as the editor reports them. The chip
  // is the binding, not a second control beside it — and nothing re-reads the action text for
  // mentions, so a `#word` the author merely wrote stays prose. A directive hands off to one
  // skill, so a second chip is an authoring error the form reports rather than silently drops.
  actionSkillNames: string[]
  priority: string
  replaces: string[]
  // Which generators the directive addresses. Always holds at least one; the reply
  // alone normalizes back to an empty stored scope on save.
  surfaces: DirectiveSurface[]
  // Carried invisibly through the dialog: the row toggle is the only control that changes this,
  // so editing a disabled directive's text must not flip it back on as a side effect of saving.
  enabled: boolean
}

// `default` mirrors AUTHORED_DIRECTIVE_STEERING_DEFAULT_PRIORITY in
// backend/src/modules/agents/authoredDirectiveMapper.ts. The directives API does not report it, so
// the priority scale would have to invent a number without this copy.
export const DIRECTIVE_PRIORITY = { min: 0, max: 100, default: 50 } as const

// A directive binds a skill that can answer the turn it claims: an external MCP tool, or a
// retrieval skill staged as a lookup. Mirrors what the API accepts, so an offered skill is
// never rejected on save.
const BINDABLE_STORED_KINDS = new Set(['external_mcp', 'retrieve'])
const DIRECTIVE_SKILL_EMPTY_MESSAGE = 'No skill can answer a turn yet. A directive can draw on an MCP tool, or a knowledge lookup the agent is allowed to pick.'
const DIRECTIVE_CAPABILITY_UNAVAILABLE_REASON = 'Not available for directives.'
// A capability that settles with outputs instead of reply text cannot back a directive, but it is
// not useless — it is how routine steps act. Point at the surface that accepts it rather than
// refusing without a destination.
const DIRECTIVE_CAPABILITY_ROUTINE_REASON = 'Acts instead of replying. Use it in a routine step.'
const DIRECTIVE_CAPABILITY_PICKER_DESCRIPTION =
  'Choose a tool or knowledge lookup the reply draws on. Skills that send or post a message belong in a routine step instead.'

const CONDITION_CHOICES = [
  {
    kind: 'always',
    title: 'Always',
    description: 'On every turn. Use this to shape how the agent always replies.',
  },
  {
    kind: 'contextual',
    title: 'In a specific situation',
    description: 'Only on turns where a situation you describe is true.',
  },
] as const satisfies ReadonlyArray<{ kind: DirectiveCondition['kind']; title: string; description: string }>

const isBindableSkill = (skill: AgentSkill): boolean =>
  skill.enabled
  && skill.invocationMode === 'agent_selectable'
  && BINDABLE_STORED_KINDS.has(skill.storedKind)

// The capabilities that can produce a bindable skill. Same rule as `isBindableSkill`, read one
// step earlier: a capability that cannot be agent-selectable would author a skill this surface
// then refuses.
const canAuthorBindableSkill = (capability: SkillCapabilityDescriptor): boolean =>
  BINDABLE_STORED_KINDS.has(capability.storedKind)
  && capability.supportedInvocationModes.includes('agent_selectable')

// Read structurally rather than from a list of capability names, so a capability added later gets
// the right answer without this file learning about it.
const directiveUnavailableReason = (capability: SkillCapabilityDescriptor): string =>
  capability.supportedInvocationModes.includes('routine_named')
    ? DIRECTIVE_CAPABILITY_ROUTINE_REASON
    : DIRECTIVE_CAPABILITY_UNAVAILABLE_REASON

// Which control an error belongs to, so the dialog can mark that control invalid and stay quiet
// until the operator has either written the field or asked to save.
type DirectiveFormField = 'name' | 'situation' | 'instruction' | 'priority'
type DirectiveFormError = { field: DirectiveFormField; message: string }

// The directive is mid-authoring while its skill is created: the chip is only inserted once the
// promise resolves with the name the API actually assigned.
type PendingSkillCreation = {
  typedName: string
  resolve: (skillName: string | null) => void
}

const emptyForm: DirectiveFormState = {
  name: '',
  conditionKind: 'always',
  conditionDescription: '',
  action: '',
  actionSkillNames: [],
  surfaces: ['answer'],
  priority: '',
  replaces: [],
  enabled: true,
}

// The binding names the one mention the stored action is known to carry. Everything else in the
// text — including any other `#word` the author wrote — is prose.
const recognizedMentions = (directive: Directive): string[] =>
  directive.binding?.skillName ? [directive.binding.skillName] : []

// A binding written through the API can name a skill the action text never mentions. Surface
// it as a chip so the author can see and remove it, instead of editing around an invisible rule.
//
// The "is it already there?" question goes to the same reader that decides which mentions seed as
// chips, so the two cannot disagree. The action is the instruction the model reads, so appending a
// second copy of a mention the author already wrote corrupts it; skipping the append when the text
// carries no mention loses the binding on the next save. Both failures land on a save the operator
// sees as a no-op, and only one reader of the text can rule out both.
const actionWithBinding = (action: string, skillName: string): string => {
  if (!skillName || mentionsSkill(action, skillName)) return action
  return `${action.trimEnd()} #${skillName}`.trim()
}

const directiveToForm = (directive: Directive): DirectiveFormState => ({
  name: directive.name,
  conditionKind: directive.condition.kind,
  conditionDescription: directive.condition.kind === 'contextual' ? directive.condition.description : '',
  action: actionWithBinding(directive.action, directive.binding?.skillName ?? ''),
  actionSkillNames: recognizedMentions(directive),
  priority: directive.priority == null ? '' : String(directive.priority),
  replaces: directive.excludes ?? [],
  surfaces: directiveSurfacesToForm(directive.surfaces),
  enabled: directive.enabled,
})

const overrideNameFor = (builtInName: string): string => `Override: ${builtInName}`

const parsePriority = (raw: string): number | null => {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  return Number.isInteger(value) ? value : null
}

const formToPayload = (form: DirectiveFormState): DirectiveCreateRequest => {
  const condition: DirectiveCondition =
    form.conditionKind === 'contextual'
      ? { kind: 'contextual', description: form.conditionDescription.trim() }
      : { kind: 'always' }

  const replaces = dedupeNames(form.replaces.map((name) => name.trim()).filter(Boolean))
  const bindingSkillName = (form.actionSkillNames[0] ?? '').trim()
  const payload: DirectiveCreateRequest = {
    name: form.name.trim(),
    condition,
    action: form.action.trim(),
    // Explicitly null when the chip is gone: an omitted binding keeps the stored one.
    binding: bindingSkillName ? { kind: 'skill', skillName: bindingSkillName } : null,
    priority: parsePriority(form.priority),
    // Always sent, never conditional: an omitted scope keeps the stored one, so a
    // directive narrowed to one generator could never be widened back.
    surfaces: formSurfacesToPayload(form.surfaces),
    // Always sent, never conditional: the update service reads an omitted field as
    // "keep what is stored", so an emptied list — including one this form pruned
    // because a surface change made the replacement impossible — would survive in
    // storage and come back the moment the surfaces overlapped again.
    excludes: replaces,
    // Always sent: the row toggle, not this dialog, is the control for this field, so an
    // omission must never be read as "leave it as the API found it" — the API has no other
    // signal, and the field is never touched by anything else in this form.
    enabled: form.enabled,
  }
  return payload
}

const directiveToPayload = (
  directive: Directive,
  options: { excludes?: string[] } = {},
): DirectiveUpdateRequest => ({
  name: directive.name,
  condition: directive.condition,
  action: directive.action,
  binding: directive.binding,
  priority: directive.priority,
  surfaces: directive.surfaces,
  requiredCapabilities: directive.requiredCapabilities,
  dependsOn: directive.dependsOn,
  excludes: options.excludes ?? directive.excludes,
  description: directive.description,
  metadata: directive.metadata,
  // Superseding resends the winner unmodified apart from the new exclusion: a disabled
  // directive that wins a conflict must stay disabled rather than come back to life as a
  // side effect of the resend.
  enabled: directive.enabled,
})

const dedupeNames = (names: string[]): string[] => Array.from(new Set(names))

const describeCondition = (condition: DirectiveCondition): string =>
  condition.kind === 'always' ? 'Always applies' : `When: ${condition.description}`

function CoherenceResolver({
  coherence,
  directives,
  subjectId,
  onSupersede,
  onMakeConditional,
  isSaving,
  isRowPending,
}: {
  coherence: DirectiveCoherence
  directives: Directive[]
  subjectId: string | null
  onSupersede: (winner: Directive, loser: Directive) => void
  onMakeConditional: (directive: Directive) => void
  isSaving: boolean
  // Each of these actions resubmits one directive in full, from the copy this panel is holding.
  // A row mutation in flight for that directive is about to change what "in full" means, so the
  // action waits rather than writing a stale value back over it.
  isRowPending: (directiveId: string) => boolean
}) {
  if (coherence.coherent) {
    return (
      <div className="rounded-xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground" role="status">
        No directive conflicts were found.
      </div>
    )
  }

  const subject = subjectId ? directives.find((directive) => directive.id === subjectId) : undefined

  return (
    <div className="space-y-3 rounded-xl border border-border bg-muted/50 p-4" role="status">
      <div>
        <p className="text-sm font-medium text-foreground">Potential directive conflicts</p>
        <p className="text-sm text-muted-foreground">{coherence.rationale}</p>
      </div>
      {coherence.conflicts.length > 0 ? (
        <div className="space-y-3">
          {coherence.conflicts.map((conflict) => {
            const existing = directives.find((directive) =>
              conflict.directiveId ? directive.id === conflict.directiveId : directive.name === conflict.directiveName
            )
            const canResolve = subject
              && existing
              && subject.id !== existing.id
              && directiveSurfacesOverlap(subject.surfaces, existing.surfaces)
            return (
              <div key={`${conflict.directiveName}-${conflict.reason}`} className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">{conflict.directiveName}:</span> {conflict.reason}
                </p>
                {subject && existing && canResolve ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isSaving || isRowPending(subject.id)}
                      onClick={() => onSupersede(subject, existing)}
                      aria-label={`${subject.name} supersedes ${existing.name}`}
                    >
                      {subject.name} supersedes {existing.name}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isSaving || isRowPending(existing.id)}
                      onClick={() => onSupersede(existing, subject)}
                      aria-label={`${existing.name} supersedes ${subject.name}`}
                    >
                      {existing.name} supersedes {subject.name}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isSaving || isRowPending(subject.id)}
                      onClick={() => onMakeConditional(subject)}
                      aria-label={`Make ${subject.name} apply only conditionally`}
                    >
                      Make {subject.name} apply only conditionally
                    </Button>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

// What the numbers actually mean on this agent, read off the built-ins the API returned rather
// than a hard-coded ladder that would drift the moment a built-in is re-ranked.
function PriorityScale({ builtIns }: { builtIns: BuiltInDirective[] }) {
  const rows = useMemo(() => {
    const ranked = builtIns
      .filter((directive): directive is BuiltInDirective & { priority: number } => directive.priority != null)
      .map((directive) => ({ priority: directive.priority, label: directive.name }))
    return [...ranked, { priority: DIRECTIVE_PRIORITY.default, label: 'default for your directives' }]
      .sort((first, second) => second.priority - first.priority)
  }, [builtIns])

  if (builtIns.length === 0) return null

  return (
    <dl className="grid grid-cols-[2.5rem_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
      {rows.map((row) => (
        <Fragment key={`${row.priority}-${row.label}`}>
          <dt className="tabular-nums">{row.priority}</dt>
          <dd className="truncate">{row.label}</dd>
        </Fragment>
      ))}
    </dl>
  )
}

function DirectiveRow({
  id,
  directive,
  readOnly = false,
  replacedBy,
  replaces,
  onEdit,
  onDelete,
  onOverride,
  onFocusReplacement,
  onToggleEnabled,
  isTogglingEnabled = false,
}: {
  id?: string
  directive: Directive | BuiltInDirective
  readOnly?: boolean
  replacedBy?: Directive
  replaces?: string[]
  onEdit?: () => void
  onDelete?: () => void
  onOverride?: () => void
  onFocusReplacement?: () => void
  // Only ever passed for an authored directive. Built-ins have no `enabled` field of their own
  // and are not affected by this control.
  onToggleEnabled?: (enabled: boolean) => void
  isTogglingEnabled?: boolean
}) {
  // A contextual replacer only supersedes this built-in when its condition
  // fires, so the built-in still applies normally the rest of the time. Only an
  // unconditional (always) replacer fully retires it — that's the one we fade
  // out and strike through.
  const isConditionalReplacement = replacedBy?.condition.kind === 'contextual'
  const isFullyReplaced = replacedBy != null && !isConditionalReplacement
  // Built-ins have no `enabled` field of their own and are never turned off from here.
  const isDisabled = 'enabled' in directive && !directive.enabled
  return (
    <div
      id={id}
      tabIndex={id ? -1 : undefined}
      className={`space-y-3 rounded-lg border border-border p-4 ${isFullyReplaced || isDisabled ? 'bg-muted/40 text-muted-foreground' : ''}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className={`text-sm font-medium text-foreground ${isFullyReplaced ? 'line-through decoration-muted-foreground/70' : ''}`}>
              {directive.name}
            </p>
            {readOnly ? (
              <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                Read-only
              </span>
            ) : null}
            {isDisabled ? (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                Disabled
              </span>
            ) : null}
            {directive.priority != null ? (
              <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                Priority {directive.priority}
              </span>
            ) : null}
            {/* Built-ins carry no scope of their own and always address the reply. */}
            {'surfaces' in directive && directiveSurfaceLabel(directive.surfaces) ? (
              <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                {directiveSurfaceLabel(directive.surfaces)}
              </span>
            ) : null}
            {replaces?.map((name) => (
              <span key={name} className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {directive.condition.kind === 'contextual' ? `Replaces ${name} when active` : `Replaces: ${name}`}
              </span>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {describeCondition(directive.condition)}
          </p>
          {replacedBy ? (
            <p className="text-xs text-muted-foreground">
              Replaced by{' '}
              <button
                type="button"
                className="font-medium text-foreground underline-offset-4 hover:underline"
                onClick={onFocusReplacement}
              >
                {replacedBy.name}
              </button>
              {replacedBy.condition.kind === 'contextual' ? (
                <> only when: {replacedBy.condition.description}. Otherwise this default still applies.</>
              ) : null}
            </p>
          ) : null}
          {'description' in directive && directive.description ? (
            <p className="text-xs text-muted-foreground">{directive.description}</p>
          ) : null}
        </div>
        {readOnly && !replacedBy ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onOverride}
            aria-label={`Replace ${directive.name} for this agent`}
          >
            Override
          </Button>
        ) : !readOnly ? (
          <div className="flex shrink-0 items-center gap-1">
            {onToggleEnabled ? (
              <Switch
                checked={!isDisabled}
                onCheckedChange={onToggleEnabled}
                disabled={isTogglingEnabled}
                aria-label={`${isDisabled ? 'Enable' : 'Disable'} ${directive.name}`}
              />
            ) : null}
            {/* The dialog opens from this row's current values and always resends them on save,
                so editing while the toggle is still in flight would save the pre-toggle state
                back over it. Both actions wait out the request rather than race it. */}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onEdit}
              disabled={isTogglingEnabled}
              aria-label={`Edit ${directive.name}`}
            >
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onDelete}
              disabled={isTogglingEnabled}
              aria-label={`Delete ${directive.name}`}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ) : null}
      </div>
      {/* The instruction keeps the line breaks its author wrote, so the row reads them back
          instead of collapsing every line into one. */}
      <p className={`whitespace-pre-wrap text-sm ${replacedBy ? 'text-muted-foreground' : 'text-foreground'}`}>{directive.action}</p>
    </div>
  )
}

export function AssistantDirectivesSection({
  agentId,
  onSaveStateChange,
}: {
  agentId: string
  onSaveStateChange?: (input: { state: 'idle' | 'saved' | 'saving' | 'error'; message?: string | null }) => void
}) {
  const [directives, setDirectives] = useState<Directive[]>([])
  const [builtIns, setBuiltIns] = useState<BuiltInDirective[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [coherence, setCoherence] = useState<DirectiveCoherence | null>(null)
  const [coherenceSubjectId, setCoherenceSubjectId] = useState<string | null>(null)
  const [editingDirective, setEditingDirective] = useState<Directive | null>(null)
  const [deletingDirective, setDeletingDirective] = useState<Directive | null>(null)
  // The row toggle is a per-row mutation, not a section save: two rows can be in flight at once,
  // and this section reloads in place when the operator switches agents rather than unmounting.
  // Both facts live in the hook so this component does not hand-roll them again.
  const rowMutations = useScopedRowMutations(agentId)
  const [form, setForm] = useState<DirectiveFormState>(emptyForm)
  // A dialog that reports "Name is required." before the operator has typed anything is scolding
  // them for not having started. Errors wait for the field to be written or for a save attempt.
  const [touchedFields, setTouchedFields] = useState<Partial<Record<DirectiveFormField, boolean>>>({})
  const [hasAttemptedSave, setHasAttemptedSave] = useState(false)
  const [agentSkills, setAgentSkills] = useState<AgentSkill[]>([])
  const [skillLoadError, setSkillLoadError] = useState<string | null>(null)
  // The agent whose skills `agentSkills` holds. It stays null while a fetch is outstanding and
  // after one fails, which is what keeps a pending or failed load from reporting a valid
  // directive as invalid — and, because it is compared against the current agent rather than
  // latched, a later attempt can still succeed.
  const [skillsAgentId, setSkillsAgentId] = useState<string | null>(null)
  const skillsLoaded = skillsAgentId === agentId
  // Null until the capability catalog is read; it is only needed to author a skill inline. It
  // carries the agent it was read for, because this section is not remounted when the dashboard
  // switches agents — an untagged catalog would keep offering the previous agent's capabilities.
  const [skillCapabilities, setSkillCapabilities] = useState<
    { agentId: string; capabilities: SkillCapabilityDescriptor[] } | null
  >(null)
  const [pendingSkillCreation, setPendingSkillCreation] = useState<PendingSkillCreation | null>(null)
  const [creationCapabilityId, setCreationCapabilityId] = useState<AgentSkillCapabilityId | null>(null)
  const [skillFormError, setSkillFormError] = useState<string | null>(null)
  const [isCreatingSkill, setIsCreatingSkill] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const { beginSave, isCurrentSave, markError, markSaved, resetSaveState } = useSettingsSaveStatus(onSaveStateChange)
  const bindableSkills = useMemo<SkillMentionOption[]>(
    () => agentSkills
      .filter(isBindableSkill)
      .map((skill) => ({ skillName: skill.name, displayName: skill.name })),
    [agentSkills],
  )
  const bindableCapabilities = useMemo(
    () => (skillCapabilities?.agentId === agentId ? skillCapabilities.capabilities : []).filter(canAuthorBindableSkill),
    [agentId, skillCapabilities],
  )
  const directiveCapabilities = useMemo(
    () => (skillCapabilities?.agentId === agentId ? skillCapabilities.capabilities : []).map((capability) =>
      // A kind that can never back a binding says so even when it also lacks a connection:
      // "Needs connection" would promise that connecting unlocks it for directives.
      canAuthorBindableSkill(capability)
        ? capability
        : { ...capability, available: false, unavailableReason: directiveUnavailableReason(capability) },
    ),
    [agentId, skillCapabilities],
  )
  const eligibleReplacementNames = useCallback((
    surfaces: readonly DirectiveSurface[],
    subjectId: string | undefined,
  ): Set<string> => new Set([
    ...directives
      .filter((directive) =>
        directive.id !== subjectId
        && directiveSurfacesOverlap(surfaces, directive.surfaces)
      )
      .map((directive) => directive.name),
    ...(directiveSurfacesOverlap(surfaces, undefined)
      ? builtIns.map((directive) => directive.name)
      : []),
  ]), [builtIns, directives])
  const effectiveReplacements = useMemo(() => {
    const targetSurfaces = new Map<string, readonly DirectiveSurface[] | undefined>()
    for (const directive of builtIns) targetSurfaces.set(directive.name, undefined)
    for (const directive of directives) targetSurfaces.set(directive.name, directive.surfaces)

    const replacements = new Map<string, string[]>()
    for (const directive of directives) {
      replacements.set(
        directive.id,
        (directive.excludes ?? []).filter((name) =>
          targetSurfaces.has(name)
          && directiveSurfacesOverlap(directive.surfaces, targetSurfaces.get(name))
        ),
      )
    }
    return replacements
  }, [builtIns, directives])
  const supersededBuiltIns = useMemo(() => {
    const replacements = new Map<string, Directive>()
    for (const directive of directives) {
      // A disabled directive never becomes a runtime Directive, so its excludes never fire and
      // the built-in it names is still fully live. This map drives the built-in's displayed
      // status, a statement about live behavior, so a disabled replacer must not retire it.
      if (!directive.enabled) continue
      // Built-ins govern the reply. An exclusion authored through an older API client may name
      // one from a suggestion-only directive, but those rules never meet on a generator and the
      // UI must not retire the built-in as though they did.
      if (!directiveSurfacesOverlap(directive.surfaces, undefined)) continue
      for (const builtInName of directive.excludes ?? []) {
        if (!replacements.has(builtInName)) {
          replacements.set(builtInName, directive)
        }
      }
    }
    return replacements
  }, [directives])

  const replaceCandidates = useMemo(() => {
    const eligibleNames = eligibleReplacementNames(form.surfaces, editingDirective?.id)
    const authored = directives
      .filter((directive) => eligibleNames.has(directive.name))
      .map((directive) => ({ name: directive.name, description: directive.description ?? null }))
    const builtInTargets = builtIns
      .filter((directive) => eligibleNames.has(directive.name))
      .map((directive) => ({ name: directive.name, description: directive.description ?? null }))
    return { builtIns: builtInTargets, authored }
  }, [builtIns, directives, editingDirective, eligibleReplacementNames, form.surfaces])

  const formError = useMemo<DirectiveFormError | null>(() => {
    if (!form.name.trim()) return { field: 'name', message: 'Name is required.' }
    if (!form.action.trim()) return { field: 'instruction', message: 'Instruction is required.' }
    if (form.conditionKind === 'contextual' && !form.conditionDescription.trim()) {
      return { field: 'situation', message: 'Describe the situation this applies to.' }
    }
    // A directive hands the turn to one skill, so chips naming two different skills would leave
    // the second one looking wired when only the first is. Repeating the same skill is one
    // unambiguous binding — a sentence like "use it, and if that fails use it again" says the
    // name twice and means it once, so it saves.
    const mentioned = dedupeNames(form.actionSkillNames)
    if (mentioned.length > 1) {
      return {
        field: 'instruction',
        message: `A directive can draw on one skill. This instruction names ${mentioned.join(', ')}. Remove the chips for all but one.`,
      }
    }
    if (mentioned.length > 0 && !form.surfaces.includes('answer')) {
      return {
        field: 'instruction',
        message: 'A skill can only hand off the agent\'s reply. Remove the skill, or apply this directive to the reply.',
      }
    }
    // A bound skill can be disabled, renamed, or moved out of agent-selectable after the
    // directive was written, and the API then rejects the binding. Say which skill is the
    // problem here rather than surface a request failure. Skipped until the list loads: an
    // unread or failed fetch must not block a directive that is fine.
    // Only while the directive is in play: a disabled directive cannot dispatch its skill, so the
    // API accepts it with a broken binding, and blocking the save here would leave the operator
    // unable to reword a rule they have already turned off.
    if (skillsLoaded && form.enabled) {
      const unbindable = mentioned.find((name) => !bindableSkills.some((skill) => skill.skillName === name))
      if (unbindable) {
        return {
          field: 'instruction',
          message: `No skill named ${unbindable} is available to bind. Remove the chip, or enable the skill and make it agent-selectable.`,
        }
      }
    }
    const trimmedPriority = form.priority.trim()
    if (trimmedPriority !== '') {
      const value = Number(trimmedPriority)
      if (!Number.isInteger(value) || value < DIRECTIVE_PRIORITY.min || value > DIRECTIVE_PRIORITY.max) {
        return {
          field: 'priority',
          message: `Priority must be a whole number between ${DIRECTIVE_PRIORITY.min} and ${DIRECTIVE_PRIORITY.max}.`,
        }
      }
    }
    return null
  }, [form, bindableSkills, skillsLoaded])

  // A field that already carries content is not being scolded before it is written: every error
  // left on it is about what is there. That is what makes a reopened directive report a broken
  // binding at once, while a blank new one stays quiet.
  const fieldHasContent = (field: DirectiveFormField): boolean => {
    switch (field) {
      case 'name': return form.name.trim() !== ''
      case 'situation': return form.conditionDescription.trim() !== ''
      case 'instruction': return form.action.trim() !== '' || form.actionSkillNames.length > 0
      case 'priority': return form.priority.trim() !== ''
    }
  }

  const visibleFormError =
    formError && (hasAttemptedSave || touchedFields[formError.field] || fieldHasContent(formError.field))
      ? formError
      : null
  const invalidField = visibleFormError?.field ?? null

  const markTouched = (field: DirectiveFormField) => {
    setTouchedFields((current) => (current[field] ? current : { ...current, [field]: true }))
  }

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (!active) return
      setIsLoading(true)
      setDirectives([])
      setBuiltIns([])
      setCoherence(null)
      setCoherenceSubjectId(null)
      setError(null)
      void directivesApi.listDirectives(agentId)
        .then((response) => {
          if (!active) return
          setDirectives(response.directives)
          setBuiltIns(response.builtIns)
          setError(null)
        })
        .catch((loadError) => {
          if (!active) return
          setError(getApiErrorMessage(loadError, 'Failed to load directives.'))
        })
        .finally(() => {
          if (!active) return
          setIsLoading(false)
        })
    })
    return () => {
      active = false
    }
  }, [agentId])

  // The skills the Action field can offer. A failure here leaves the field working as plain
  // text — a directive that only steers wording needs no skill at all. Opening or closing the
  // editor re-attempts a fetch that has not landed, because the editor is where the answer is
  // needed and one bad request must not disable binding validation for the rest of the session.
  useEffect(() => {
    if (skillsLoaded) return
    let active = true
    queueMicrotask(() => {
      if (!active) return
      setAgentSkills([])
      setSkillLoadError(null)
      void agentSkillsApi.listSkills(agentId)
        .then((response) => {
          if (!active) return
          setAgentSkills(response.skills)
          setSkillsAgentId(agentId)
          setSkillLoadError(null)
        })
        .catch((loadError) => {
          if (!active) return
          setAgentSkills([])
          setSkillLoadError(getApiErrorMessage(loadError, 'Could not load skills for this directive.'))
        })
    })
    return () => {
      active = false
    }
  }, [agentId, dialogOpen, skillsLoaded])

  // Authoring a skill inline needs the capability catalog, which nothing else on this section
  // reads. It loads with the editing dialog so the section's own load stays one request, and
  // reloads whenever it holds another agent's answer.
  useEffect(() => {
    if (!dialogOpen || skillCapabilities?.agentId === agentId) return
    let active = true
    void agentSkillsApi.getSkillCapabilities(agentId)
      .then((response) => {
        if (active) setSkillCapabilities({ agentId, capabilities: response.capabilities })
      })
      .catch(() => {
        // No catalog means no inline authoring; the field still binds catalogued skills.
        if (active) setSkillCapabilities({ agentId, capabilities: [] })
      })
    return () => {
      active = false
    }
  }, [agentId, dialogOpen, skillCapabilities])

  // Identity has to be stable: the mention menu rebuilds its options whenever this changes.
  const requestSkillCreation = useCallback(
    (typedName: string) =>
      new Promise<string | null>((resolve) => {
        setCreationCapabilityId(null)
        setSkillFormError(null)
        setPendingSkillCreation({ typedName, resolve })
      }),
    [],
  )

  const cancelSkillCreation = () => {
    if (isCreatingSkill) return
    pendingSkillCreation?.resolve(null)
    setPendingSkillCreation(null)
    setCreationCapabilityId(null)
    setSkillFormError(null)
  }

  const createBoundSkill = async (input: AgentSkillCreateInput) => {
    const pending = pendingSkillCreation
    if (!pending) return
    setIsCreatingSkill(true)
    setSkillFormError(null)
    try {
      // Authored for a binding, so it is created bindable. The form's defaults are tuned for
      // routine use, and a skill saved that way would go amber in the chip it was created for.
      const { skill } = await agentSkillsApi.createSkill(agentId, {
        ...input,
        enabled: true,
        invocationMode: 'agent_selectable',
      })
      setAgentSkills((current) => [skill, ...current])
      setPendingSkillCreation(null)
      setCreationCapabilityId(null)
      pending.resolve(skill.name)
    } catch (createError) {
      setSkillFormError(getApiErrorMessage(createError, 'Failed to create skill.'))
    } finally {
      setIsCreatingSkill(false)
    }
  }

  const openDialogWith = (nextForm: DirectiveFormState, directive: Directive | null) => {
    const eligibleNames = eligibleReplacementNames(nextForm.surfaces, directive?.id)
    setEditingDirective(directive)
    setForm({
      ...nextForm,
      // Old API clients could store a cross-surface exclusion the runtime correctly ignores.
      // Do not preserve that no-op as a selected chip or send it back on the next edit.
      replaces: nextForm.replaces.filter((name) => eligibleNames.has(name)),
    })
    setError(null)
    setTouchedFields({})
    setHasAttemptedSave(false)
    setDialogOpen(true)
  }

  const openCreateDialog = () => openDialogWith(emptyForm, null)

  const openEditDialog = (directive: Directive) => openDialogWith(directiveToForm(directive), directive)

  const openConditionalEditDialog = (directive: Directive) =>
    openDialogWith({ ...directiveToForm(directive), conditionKind: 'contextual' }, directive)

  // The per-built-in "Override" button is a shortcut into the normal create
  // dialog with the built-in pre-selected in Replaces, so it reads as
  // "cancel this built-in and run mine instead" with everything else editable.
  const openOverrideDialog = (directive: BuiltInDirective) =>
    openDialogWith({ ...emptyForm, name: overrideNameFor(directive.name), replaces: [directive.name] }, null)

  const toggleReplace = (name: string, checked: boolean) => {
    setForm((current) => ({
      ...current,
      replaces: checked
        ? dedupeNames([...current.replaces, name])
        : current.replaces.filter((replaced) => replaced !== name),
    }))
  }

  const toggleSurface = (surface: DirectiveSurface) => {
    setForm((current) => {
      const surfaces = toggleDirectiveSurface(current.surfaces, surface, {
        answerRequired: current.actionSkillNames.length > 0,
      })
      const eligibleReplacements = eligibleReplacementNames(surfaces, editingDirective?.id)
      return {
        ...current,
        surfaces,
        // Surface changes can invalidate an existing selection. Drop it at the same state
        // boundary so a now-hidden chip cannot still be submitted to the API.
        replaces: current.replaces.filter((name) => eligibleReplacements.has(name)),
      }
    })
  }

  const focusDirective = (directiveId: string) => {
    const element = document.getElementById(`directive-${directiveId}`)
    element?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    element?.focus({ preventScroll: true })
  }

  const closeDialog = () => {
    if (isSaving) return
    pendingSkillCreation?.resolve(null)
    setPendingSkillCreation(null)
    setCreationCapabilityId(null)
    setDialogOpen(false)
    setEditingDirective(null)
    setForm(emptyForm)
    setTouchedFields({})
    setHasAttemptedSave(false)
  }

  const mergeSavedDirective = (savedDirective: Directive) => {
    setDirectives((current) => {
      const withoutSaved = current.filter((directive) => directive.id !== savedDirective.id)
      return [...withoutSaved, savedDirective].sort((first, second) => first.name.localeCompare(second.name))
    })
  }

  const handleSupersede = async (winner: Directive, loser: Directive) => {
    if (!directiveSurfacesOverlap(winner.surfaces, loser.surfaces)) return
    const saveId = beginSave()
    setIsSaving(true)
    setError(null)
    try {
      const response = await directivesApi.updateDirective(
        agentId,
        winner.id,
        directiveToPayload(winner, {
          excludes: dedupeNames([...(winner.excludes ?? []), loser.name]),
        }),
      )
      if (!isCurrentSave(saveId)) return
      mergeSavedDirective(response.directive)
      setCoherence(response.coherence)
      setCoherenceSubjectId(response.directive.id)
      markSaved()
    } catch (saveError) {
      if (!isCurrentSave(saveId)) return
      const message = getApiErrorMessage(saveError, 'Failed to resolve directive conflict.')
      setError(message)
      markError(message)
    } finally {
      if (isCurrentSave(saveId)) {
        setIsSaving(false)
      }
    }
  }

  const handleSubmit = async () => {
    // Save stays enabled while the form is invalid: a dead button with no stated reason leaves the
    // operator guessing. Asking to save is what reveals the message.
    if (formError) {
      setHasAttemptedSave(true)
      return
    }
    const payload = formToPayload(form)
    const saveId = beginSave()
    setIsSaving(true)
    setError(null)
    try {
      const response = editingDirective
        ? await directivesApi.updateDirective(agentId, editingDirective.id, payload satisfies DirectiveUpdateRequest)
        : await directivesApi.createDirective(agentId, payload)
      if (!isCurrentSave(saveId)) return
      mergeSavedDirective(response.directive)
      setCoherence(response.coherence)
      setCoherenceSubjectId(response.directive.id)
      setDialogOpen(false)
      setEditingDirective(null)
      setForm(emptyForm)
      setTouchedFields({})
      setHasAttemptedSave(false)
      markSaved()
    } catch (saveError) {
      if (!isCurrentSave(saveId)) return
      const message = getApiErrorMessage(saveError, 'Failed to save directive.')
      setError(message)
      markError(message)
    } finally {
      if (isCurrentSave(saveId)) {
        setIsSaving(false)
      }
    }
  }

  // A one-click, reversible response to a misfiring directive: the row toggle, not the edit
  // dialog. The response replaces the row from the server rather than flipping it optimistically,
  // matching skill enablement (SkillList.toggleSkill), and reports through the same save protocol
  // as every other mutation here so a toggle is not invisible to the section's save state.
  //
  // Unlike the dialog saves, two toggles can be in flight at once, so what each response is
  // allowed to do is split three ways. A committed row is always applied — a second toggle on
  // another row does not make the first one's result untrue, and skipping it would leave a row
  // showing the opposite of what the server stored until a reload. The section's single save-state
  // chip stays last-write-wins, since it has only one thing to say. Only the agent is a hard gate:
  // a response for an agent the operator has navigated away from describes another list entirely.
  const handleToggleEnabled = async (directive: Directive, enabled: boolean) => {
    const saveId = beginSave()
    setError(null)
    const outcome = await rowMutations.run(directive.id, () =>
      directivesApi.updateDirective(agentId, directive.id, { enabled }))

    // beginSave already told the section it is saving. A stale outcome has nothing to report about
    // this list, but leaving the announcement unanswered strands the page's save indicator on
    // "saving" until some unrelated save happens to close it out. Only the newest save may reset,
    // so a mutation still in flight keeps its own state.
    if (outcome.status === 'stale') {
      if (isCurrentSave(saveId)) resetSaveState()
      return
    }
    if (outcome.status === 'failed') {
      const message = getApiErrorMessage(outcome.error, 'Failed to update directive.')
      setError(message)
      // The section's save chip has one thing to say, so it stays last-write-wins. What happened
      // to this row is a separate question, and the hook answers it per row.
      if (isCurrentSave(saveId)) markError(message)
      return
    }

    mergeSavedDirective(outcome.value.directive)
    // Disabling skips the backend coherence check (it comes back coherent, clearing any
    // stale panel about a rule that is no longer in play); re-enabling runs the real check,
    // so this is the same verdict-threading handleSubmit and handleSupersede already do.
    setCoherence(outcome.value.coherence)
    setCoherenceSubjectId(outcome.value.directive.id)
    if (isCurrentSave(saveId)) markSaved()
  }

  const handleDelete = async () => {
    if (!deletingDirective) return
    const saveId = beginSave()
    setIsSaving(true)
    setError(null)
    try {
      await directivesApi.deleteDirective(agentId, deletingDirective.id)
      if (!isCurrentSave(saveId)) return
      setDirectives((current) => current.filter((directive) => directive.id !== deletingDirective.id))
      setDeletingDirective(null)
      setCoherence(null)
      setCoherenceSubjectId(null)
      markSaved()
    } catch (deleteError) {
      if (!isCurrentSave(saveId)) return
      const message = getApiErrorMessage(deleteError, 'Failed to delete directive.')
      setError(message)
      markError(message)
    } finally {
      if (isCurrentSave(saveId)) {
        setIsSaving(false)
      }
    }
  }

  return (
    <SettingsCard
      id="assistant-directives-card"
      icon={<ScrollText className="h-5 w-5 text-primary" />}
      title="Directives"
      description={'Conditional rules that fire in specific situations — for "when X, do Y" behavior. For the agent\'s always-on persona, use Behavior; for multi-step procedures, use Routines.'}
      headerEnd={(
        <Button type="button" size="sm" onClick={openCreateDialog}>
          <Plus className="mr-2 h-4 w-4" />
          New directive
        </Button>
      )}
    >
      <div className="space-y-6">
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        {coherence ? (
          <CoherenceResolver
            coherence={coherence}
            directives={directives}
            subjectId={coherenceSubjectId}
            onSupersede={(winner, loser) => void handleSupersede(winner, loser)}
            onMakeConditional={openConditionalEditDialog}
            isSaving={isSaving}
            isRowPending={rowMutations.isPending}
          />
        ) : null}

        <div className="space-y-3">
          <div className="space-y-1">
            <h4 className="text-sm font-semibold text-foreground">Authored directives</h4>
            <p className="text-xs text-muted-foreground">Rules created for this agent. They apply to all routes.</p>
          </div>
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="h-4 w-4" />
              Loading directives...
            </div>
          ) : directives.length > 0 ? (
            <div className="space-y-3">
              {directives.map((directive) => (
                <DirectiveRow
                  key={directive.id}
                  id={`directive-${directive.id}`}
                  directive={directive}
                  replaces={effectiveReplacements.get(directive.id) ?? []}
                  onEdit={() => openEditDialog(directive)}
                  onDelete={() => setDeletingDirective(directive)}
                  onToggleEnabled={(enabled) => void handleToggleEnabled(directive, enabled)}
                  isTogglingEnabled={rowMutations.isPending(directive.id)}
                />
              ))}
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
              No authored directives yet.
            </p>
          )}
        </div>

        <div className="space-y-3">
          <div className="space-y-1">
            <h4 className="text-sm font-semibold text-foreground">Built-in directives</h4>
            <p className="text-xs text-muted-foreground">Default Radioso behavior rules. They cannot be edited here.</p>
          </div>
          <div className="space-y-3">
            {builtIns.map((directive) => {
              const replacedBy = supersededBuiltIns.get(directive.name)
              return (
                <DirectiveRow
                  key={directive.name}
                  directive={directive}
                  readOnly
                  replacedBy={replacedBy}
                  onOverride={() => openOverrideDialog(directive)}
                  onFocusReplacement={replacedBy ? () => focusDirective(replacedBy.id) : undefined}
                />
              )
            })}
          </div>
        </div>
      </div>

      <Dialog open={dialogOpen} onOpenChange={(open) => (open ? setDialogOpen(true) : closeDialog())}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editingDirective ? 'Edit directive' : 'New directive'}
            </DialogTitle>
            <DialogDescription>
              A standing rule for this agent: when the conversation matches, the agent replies this way.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
            <div className="space-y-1.5">
              <Label htmlFor="directiveName">Name</Label>
              <Input
                id="directiveName"
                value={form.name}
                aria-invalid={invalidField === 'name'}
                onChange={(event) => {
                  markTouched('name')
                  setForm((current) => ({ ...current, name: event.target.value }))
                }}
                maxLength={120}
              />
            </div>
            <div className="space-y-1.5">
              <Label>When this applies</Label>
              <div role="radiogroup" aria-label="When this applies" className="grid gap-2 sm:grid-cols-2">
                {CONDITION_CHOICES.map((choice) => {
                  const isSelected = form.conditionKind === choice.kind
                  return (
                    <button
                      key={choice.kind}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      onClick={() => setForm((current) => ({ ...current, conditionKind: choice.kind }))}
                      className={cn(
                        'rounded-md border p-3 text-left transition-colors',
                        isSelected
                          ? 'border-primary bg-muted/40'
                          : 'border-border hover:border-primary/60 hover:bg-muted/30',
                      )}
                    >
                      <span className="block text-sm font-medium text-foreground">{choice.title}</span>
                      <span className="mt-1 block text-xs text-muted-foreground">{choice.description}</span>
                    </button>
                  )
                })}
              </div>
            </div>
            {form.conditionKind === 'contextual' ? (
              <div className="space-y-1.5">
                <Label htmlFor="directiveConditionDescription">Situation</Label>
                <p className="text-xs text-muted-foreground">
                  Plain language, no keywords — the agent judges each turn against this description.
                </p>
                <Textarea
                  id="directiveConditionDescription"
                  value={form.conditionDescription}
                  placeholder="The visitor asks about refunds after the 30-day window"
                  aria-invalid={invalidField === 'situation'}
                  onChange={(event) => {
                    markTouched('situation')
                    setForm((current) => ({ ...current, conditionDescription: event.target.value }))
                  }}
                  className="min-h-20"
                />
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="directiveAction">Instruction</Label>
              <p className="text-xs text-muted-foreground">
                How the agent should reply when this fires — a rule it follows, not a script it recites. Type #
                to have it draw on a skill.
              </p>
              <SkillMentionInput
                key={editingDirective?.id ?? 'new-directive'}
                id="directiveAction"
                ariaLabel="Instruction"
                ariaInvalid={invalidField === 'instruction'}
                placeholder="Answer in two sentences, then offer to connect them with support."
                value={form.action}
                recognizedSkillNames={editingDirective ? recognizedMentions(editingDirective) : []}
                skills={bindableSkills}
                skillMenuNotice={
                  form.actionSkillNames[0]
                    ? `The reply draws on ${form.actionSkillNames[0]}. Remove that chip to choose a different skill.`
                    : null
                }
                skillMenuEmptyMessage={DIRECTIVE_SKILL_EMPTY_MESSAGE}
                isSkillsLoading={!skillsLoaded && skillLoadError === null}
                skillLoadError={skillLoadError}
                onChange={(action) => setForm((current) => ({ ...current, action }))}
                onSkillsChange={(skillNames) =>
                  setForm((current) => ({ ...current, actionSkillNames: skillNames }))
                }
                onCreateSkill={bindableCapabilities.length > 0 ? requestSkillCreation : undefined}
              />
              {skillLoadError ? <p className="text-xs text-destructive">{skillLoadError}</p> : null}
            </div>
            <div className="space-y-1.5">
              <Label>Applies to</Label>
              <p className="text-xs text-muted-foreground">
                A turn writes more than one piece of text. This directive only shapes — and only
                competes with, replaces, or hands off for — the ones you pick.
              </p>
              {/* Deliberately lighter than the condition cards above: a modifier on the
                  instruction, not a second either/or decision of equal weight. */}
              <div className="flex flex-wrap gap-2 pt-0.5">
                {DIRECTIVE_SURFACE_CHOICES.map((choice) => {
                  const isSelected = form.surfaces.includes(choice.surface)
                  const isLockedBySkill = choice.surface === 'answer'
                    && isSelected
                    && form.actionSkillNames.length > 0
                  return (
                    <button
                      key={choice.surface}
                      type="button"
                      role="checkbox"
                      aria-checked={isSelected}
                      aria-label={choice.title}
                      title={choice.description}
                      aria-describedby={isLockedBySkill ? 'directive-answer-surface-requirement' : undefined}
                      disabled={isLockedBySkill}
                      onClick={() => toggleSurface(choice.surface)}
                      className={cn(
                        'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors',
                        isSelected
                          ? 'border-primary bg-muted/40 text-foreground'
                          : 'border-border text-muted-foreground hover:border-primary/60 hover:bg-muted/30',
                        isLockedBySkill ? 'cursor-not-allowed opacity-60' : null,
                      )}
                    >
                      <Check
                        aria-hidden
                        className={cn('h-3.5 w-3.5 shrink-0', isSelected ? 'opacity-100' : 'opacity-25')}
                      />
                      {choice.title}
                    </button>
                  )
                })}
              </div>
              {form.actionSkillNames.length > 0 ? (
                <p id="directive-answer-surface-requirement" className="text-xs text-muted-foreground">
                  Remove the skill from the instruction before deselecting the reply.
                </p>
              ) : null}
            </div>
            <DirectiveReplacesField
              builtIns={replaceCandidates.builtIns}
              authored={replaceCandidates.authored}
              selected={form.replaces}
              onToggle={toggleReplace}
            />
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Label htmlFor="directivePriority">Priority</Label>
                <span className="text-xs text-muted-foreground">Optional</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Higher wins when two directives apply at once and pull in different directions. Leave blank
                for the default, {DIRECTIVE_PRIORITY.default}.
              </p>
              <Input
                id="directivePriority"
                type="number"
                inputMode="numeric"
                min={DIRECTIVE_PRIORITY.min}
                max={DIRECTIVE_PRIORITY.max}
                value={form.priority}
                placeholder={String(DIRECTIVE_PRIORITY.default)}
                aria-invalid={invalidField === 'priority'}
                onChange={(event) => {
                  markTouched('priority')
                  setForm((current) => ({ ...current, priority: event.target.value }))
                }}
                className="w-32"
              />
              <PriorityScale builtIns={builtIns} />
            </div>
            {visibleFormError ? (
              <p className="text-sm text-destructive" role="alert">{visibleFormError.message}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeDialog} disabled={isSaving}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void handleSubmit()} disabled={isSaving}>
              {isSaving ? <Spinner className="mr-2" /> : null}
              Save directive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Authoring a skill from the Instruction field: the capability choice, then the real skill
          form. Both sit above the directive dialog and hand the created name back to the chip. */}
      <CapabilityPicker
        open={Boolean(pendingSkillCreation) && creationCapabilityId === null}
        capabilities={directiveCapabilities}
        description={DIRECTIVE_CAPABILITY_PICKER_DESCRIPTION}
        onOpenChange={(open) => !open && cancelSkillCreation()}
        onSelect={setCreationCapabilityId}
      />
      {pendingSkillCreation && creationCapabilityId ? (
        <SkillForm
          agentId={agentId}
          open
          capabilities={bindableCapabilities}
          skills={agentSkills}
          capabilityId={creationCapabilityId}
          initialName={normalizeSkillName(pendingSkillCreation.typedName)}
          isSaving={isCreatingSkill}
          error={skillFormError}
          onOpenChange={(open) => !open && cancelSkillCreation()}
          onSubmit={createBoundSkill}
        />
      ) : null}

      <Dialog open={Boolean(deletingDirective)} onOpenChange={(open) => !open && setDeletingDirective(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete directive</DialogTitle>
            <DialogDescription>
              This removes the authored directive from this agent.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Delete <span className="font-medium text-foreground">{deletingDirective?.name}</span>?
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeletingDirective(null)} disabled={isSaving}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={() => void handleDelete()} disabled={isSaving}>
              {isSaving ? <Spinner className="mr-2" /> : null}
              Delete directive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsCard>
  )
}
