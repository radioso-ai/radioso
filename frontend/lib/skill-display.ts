import { Handshake, Sparkles, type LucideIcon } from 'lucide-react'

export interface SkillDisplay {
  icon: LucideIcon
  fallbackTitle: string
}

const SKILL_DISPLAY_REGISTRY: Record<string, SkillDisplay> = {
  'human_contact.request': {
    icon: Handshake,
    fallbackTitle: 'Contact us',
  },
}

const DEFAULT_SKILL_DISPLAY: SkillDisplay = {
  icon: Sparkles,
  fallbackTitle: 'Assistant',
}

export const getSkillDisplay = (skillName: string): SkillDisplay =>
  SKILL_DISPLAY_REGISTRY[skillName] ?? DEFAULT_SKILL_DISPLAY
