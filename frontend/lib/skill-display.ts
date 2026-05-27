import { Handshake, Sparkles, type LucideIcon } from 'lucide-react'

import type { SkillCatalogEntry, SkillDisplayMetadata } from './api'

export interface SkillDisplay {
  icon: LucideIcon
  fallbackTitle: string
}

const SKILL_DISPLAY_ICONS: Record<string, LucideIcon> = {
  handshake: Handshake,
  sparkles: Sparkles,
}

const DEFAULT_SKILL_DISPLAY: SkillDisplay = {
  icon: Sparkles,
  fallbackTitle: 'Assistant',
}

export interface SkillDisplaySource {
  displayName?: string
  display?: SkillDisplayMetadata
}

export interface SkillCatalogDisplayEntry extends SkillDisplaySource {
  name: string
}

const resolveIcon = (icon: string | undefined): LucideIcon =>
  icon ? SKILL_DISPLAY_ICONS[icon] ?? DEFAULT_SKILL_DISPLAY.icon : DEFAULT_SKILL_DISPLAY.icon

const displayTitle = (source: SkillDisplaySource | null | undefined): string =>
  source?.display?.title?.trim()
    || source?.displayName?.trim()
    || DEFAULT_SKILL_DISPLAY.fallbackTitle

export const getSkillDisplay = (
  source: SkillDisplaySource | SkillCatalogEntry | null | undefined,
): SkillDisplay => ({
  icon: resolveIcon(source?.display?.icon),
  fallbackTitle: displayTitle(source),
})
