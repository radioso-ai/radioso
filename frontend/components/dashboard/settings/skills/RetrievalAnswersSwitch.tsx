'use client'

import { Switch } from '@/components/ui/switch'
import type { PlatformAnswerSkill } from '@/lib/api-skills'
import { RETRIEVAL_ANSWER_SKILL_NAME } from '@/lib/retrieval-skill-settings'

// Built-in retrieval answers are the one built-in skill an operator can switch off.
export type RetrievalAnswersControl = {
  enabled: boolean
  // Known to be off, as opposed to still loading or unreadable.
  isOff: boolean
  disabled: boolean
  onChange: (enabled: boolean) => void
}

export const isRetrievalAnswerSkill = (skill: PlatformAnswerSkill): boolean => skill.name === RETRIEVAL_ANSWER_SKILL_NAME

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
