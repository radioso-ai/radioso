import type { SkillStreamPayload } from './api-types'

export interface SkillGroupedMessage {
  role: 'user' | 'assistant' | 'system'
  skill?: SkillStreamPayload
}

export interface SkillGroupInfo {
  groupKey: string | null
  isGroupStart: boolean
  isGroupEnd: boolean
  skill?: SkillStreamPayload
}

export const computeSkillGroupInfo = <T extends SkillGroupedMessage>(
  messages: readonly T[],
): SkillGroupInfo[] => {
  const info: SkillGroupInfo[] = messages.map(() => ({
    groupKey: null,
    isGroupStart: false,
    isGroupEnd: false,
  }))

  let i = 0
  let groupIndex = 0
  while (i < messages.length) {
    const seed = messages[i]
    if (seed.role !== 'assistant' || !seed.skill) {
      i += 1
      continue
    }

    const skillName = seed.skill.skillName
    let lastSkillIndex = i
    // The chip title is sticky: the first non-empty localized title in the group wins, so the chip
    // does not visibly flip to a later turn's title (which may be empty or in a different language).
    let stickyTitle: string | undefined = seed.skill.localizedTitle?.trim() || undefined
    let latestPhase: SkillStreamPayload['phase'] = seed.skill.phase
    let latestReceipt: SkillStreamPayload['receipt'] = seed.skill.receipt
    let scan = i + 1
    while (scan < messages.length) {
      const next = messages[scan]
      if (next.role === 'user') {
        scan += 1
        continue
      }
      if (next.role === 'assistant' && next.skill?.skillName === skillName) {
        lastSkillIndex = scan
        if (!stickyTitle) {
          stickyTitle = next.skill.localizedTitle?.trim() || undefined
        }
        latestPhase = next.skill.phase
        latestReceipt = next.skill.receipt
        scan += 1
        continue
      }
      break
    }

    const aggregatedSkill: SkillStreamPayload = {
      skillName,
      phase: latestPhase,
      localizedTitle: stickyTitle,
      receipt: latestReceipt,
    }

    const key = `skill-${groupIndex}`
    for (let k = i; k <= lastSkillIndex; k += 1) {
      info[k] = {
        groupKey: key,
        isGroupStart: k === i,
        isGroupEnd: k === lastSkillIndex,
        skill: aggregatedSkill,
      }
    }
    groupIndex += 1
    i = lastSkillIndex + 1
  }

  return info
}
