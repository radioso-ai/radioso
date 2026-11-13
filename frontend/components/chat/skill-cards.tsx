'use client'

import { Check } from 'lucide-react'

import type { SkillStreamPayload } from '@/lib/api'
import type { WebsiteEmbedCopy, WebsiteEmbedTheme } from '@/lib/embed-widget'
import { getSkillDisplay, type SkillDisplaySource } from '@/lib/skill-display'

const SKILL_ACCENT_FALLBACK = '#0f172a'

const accentTint = (accent: string | undefined, percent: number): string =>
  `color-mix(in srgb, ${accent ?? SKILL_ACCENT_FALLBACK} ${percent}%, transparent)`

/** The chip above a reply that a skill gave: the skill's icon and title, in the thread's accent. */
export function SkillChip({
  skill,
  displaySource,
  theme,
}: {
  skill: SkillStreamPayload
  displaySource: SkillDisplaySource
  theme?: WebsiteEmbedTheme | null
}) {
  const display = getSkillDisplay(displaySource)
  const Icon = display.icon
  const title = skill.localizedTitle?.trim() || display.fallbackTitle
  const accent = theme?.accent ?? SKILL_ACCENT_FALLBACK
  return (
    <div
      data-skill-chip
      data-skill-name={skill.skillName}
      className="inline-flex w-fit items-center gap-1.5 self-start rounded-full border px-2.5 py-1 text-xs font-medium"
      style={{
        background: accentTint(accent, 6),
        borderColor: accentTint(accent, 18),
        color: accent,
      }}
    >
      <Icon className="size-3.5" aria-hidden style={{ color: accent }} />
      <span>{title}</span>
    </div>
  )
}

/** The receipt under a skill's reply: its status and the fields it recorded. */
export function SkillReceiptCard({
  skill,
  theme,
  copy,
}: {
  skill: SkillStreamPayload
  theme?: WebsiteEmbedTheme | null
  copy: WebsiteEmbedCopy
}) {
  const isFailed = skill.phase === 'failed'
  const statusLabel = skill.receipt?.statusLabel?.trim()
    || (isFailed ? copy.skillReceiptFailedLabel : copy.skillReceiptSubmittedLabel)
  const fields = skill.receipt?.fields ?? []
  const accent = theme?.accent ?? SKILL_ACCENT_FALLBACK
  const accentForeground = theme?.assistantBubbleForeground ?? '#0f172a'
  const mutedForeground = theme?.mutedForeground ?? '#64748b'
  return (
    <div
      data-skill-receipt
      data-skill-name={skill.skillName}
      data-skill-phase={skill.phase}
      className="w-fit max-w-full self-start rounded-2xl border px-4 py-3 text-sm"
      style={{
        background: theme?.assistantBubbleBackground ?? '#ffffff',
        borderColor: accentTint(accent, 18),
        color: accentForeground,
      }}
    >
      <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: accent }}>
        <span
          className="inline-flex size-5 items-center justify-center rounded-full"
          style={{ background: accentTint(accent, 12) }}
        >
          <Check className="size-3" aria-hidden />
        </span>
        <span>{statusLabel}</span>
      </div>
      {fields.length > 0 ? (
        <dl className="mt-1.5 flex flex-col gap-1">
          {fields.map((field) => (
            <div key={field.name} className="flex flex-col">
              <dt
                className="text-[10px] font-medium uppercase tracking-wider"
                style={{ color: mutedForeground }}
              >
                {field.displayName}
              </dt>
              <dd className="text-sm" style={{ color: accentForeground }}>
                {field.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  )
}
