'use client'

import {
  QuietDetailSheet,
  QuietSheetDetails,
  QuietSheetField,
  QuietSheetFrame,
} from '@/components/dashboard/settings/quiet-detail-sheet'
import { focusQuietListRow } from '@/components/dashboard/settings/quiet-list'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import type { AgentSkill, PlatformAnswerSkill, SkillCapabilityDescriptor } from '@/lib/api-skills'
import { formatCapabilityLabel, formatInvocationMode } from './skill-form-model'
import { builtInSkillRowDomId, skillRowDomId, skillTargetLabel } from './skill-list-rows'
import { describeSkillUsage, NO_SKILL_USAGE, type SkillUsage } from './skill-usage'

export type SkillSheetTarget =
  | { kind: 'authored'; skill: AgentSkill }
  | { kind: 'built-in'; skill: PlatformAnswerSkill }

// Built-in retrieval answers are the one built-in skill an operator can switch off.
export type RetrievalAnswersControl = {
  enabled: boolean
  disabled: boolean
  onChange: (enabled: boolean) => void
}

export type SkillSheetActions = {
  isRowPending: (skillId: string) => boolean
  onToggleEnabled: (skill: AgentSkill, enabled: boolean) => void
  onEdit: (skill: AgentSkill) => void
  onDelete: (skill: AgentSkill) => void
}

export const isRetrievalAnswerSkill = (skill: PlatformAnswerSkill): boolean => skill.name === 'retrieval.answer'

export function RetrievalAnswersSwitch({ control }: { control: RetrievalAnswersControl }) {
  return (
    <Switch
      checked={control.enabled}
      onCheckedChange={control.onChange}
      disabled={control.disabled}
      aria-label="Enable retrieval answers"
    />
  )
}

function AuthoredSkillSheet({
  skill,
  capabilities,
  usage,
  actions,
}: {
  skill: AgentSkill
  capabilities: readonly SkillCapabilityDescriptor[]
  usage: Map<string, SkillUsage> | null
  actions: SkillSheetActions
}) {
  const isBusy = actions.isRowPending(skill.id)
  const target = skillTargetLabel(skill, capabilities)
  return (
    <QuietSheetFrame
      title={`@${skill.name}`}
      subtitle={formatCapabilityLabel(skill.capability)}
      headerEnd={(
        <Switch
          checked={skill.enabled}
          onCheckedChange={(enabled) => actions.onToggleEnabled(skill, enabled)}
          disabled={isBusy}
          aria-label={`Enable ${skill.name}`}
        />
      )}
      footer={(
        <>
          <Button type="button" variant="outline" disabled={isBusy} onClick={() => actions.onEdit(skill)} aria-label={`Edit ${skill.name}`}>
            Edit
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="ml-auto text-destructive hover:text-destructive"
            disabled={isBusy}
            onClick={() => actions.onDelete(skill)}
            aria-label={`Delete ${skill.name}`}
          >
            Delete
          </Button>
        </>
      )}
    >
      <QuietSheetField label="When it runs">{formatInvocationMode(skill.invocationMode)}</QuietSheetField>
      <QuietSheetDetails
        details={[
          ...(target ? [['Target', target] as const] : []),
          // Unknown while the referencing directives and routines are unread; a guess would call a
          // used skill unused.
          ...(usage ? [['Used by', describeSkillUsage(usage.get(skill.name) ?? NO_SKILL_USAGE)] as const] : []),
        ]}
      />
    </QuietSheetFrame>
  )
}

function BuiltInSkillSheet({
  skill,
  retrievalAnswers,
}: {
  skill: PlatformAnswerSkill
  retrievalAnswers: RetrievalAnswersControl
}) {
  const isRetrieval = isRetrievalAnswerSkill(skill)
  return (
    <QuietSheetFrame
      title={skill.displayName}
      subtitle={isRetrieval ? 'Built in' : 'Built in · always on'}
      headerEnd={isRetrieval ? <RetrievalAnswersSwitch control={retrievalAnswers} /> : undefined}
    >
      <QuietSheetField label="What it does">{skill.description}</QuietSheetField>
    </QuietSheetFrame>
  )
}

export function SkillDetailSheet({
  target,
  capabilities,
  usage,
  retrievalAnswers,
  actions,
  onClose,
}: {
  target: SkillSheetTarget | null
  capabilities: readonly SkillCapabilityDescriptor[]
  usage: Map<string, SkillUsage> | null
  retrievalAnswers: RetrievalAnswersControl
  actions: SkillSheetActions
  onClose: () => void
}) {
  return (
    <QuietDetailSheet
      target={target}
      onClose={onClose}
      returnFocus={(shown) => focusQuietListRow(
        shown.kind === 'authored' ? skillRowDomId(shown.skill.id) : builtInSkillRowDomId(shown.skill.name),
      )}
    >
      {(shown) => shown.kind === 'authored'
        ? <AuthoredSkillSheet skill={shown.skill} capabilities={capabilities} usage={usage} actions={actions} />
        : <BuiltInSkillSheet skill={shown.skill} retrievalAnswers={retrievalAnswers} />}
    </QuietDetailSheet>
  )
}
