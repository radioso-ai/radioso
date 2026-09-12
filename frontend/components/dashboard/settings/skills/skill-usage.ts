// Which authored surfaces reference a skill. A skill nothing references never fires, and the
// registry is the only place that can say so.

export type SkillUsage = { directives: number; routines: number }

// The bindings and step references a usage count reads. Narrower than the full API types on
// purpose: the count does not care what else a directive or a routine carries.
type SkillUsageDirective = { binding?: { skillName?: string | null } | null }
export type SkillUsageRoutine = {
  enabled: boolean
  steps: readonly { toolRef?: string | null }[]
}

export const NO_SKILL_USAGE: SkillUsage = { directives: 0, routines: 0 }

export const countSkillUsage = (
  directives: readonly SkillUsageDirective[],
  routines: readonly SkillUsageRoutine[],
): Map<string, SkillUsage> => {
  const usage = new Map<string, SkillUsage>()
  const bump = (skillName: string, field: keyof SkillUsage) => {
    const current = usage.get(skillName) ?? { directives: 0, routines: 0 }
    usage.set(skillName, { ...current, [field]: current[field] + 1 })
  }

  for (const directive of directives) {
    const skillName = directive.binding?.skillName
    if (skillName) bump(skillName, 'directives')
  }

  // A disabled routine cannot fire, so it is not usage. Within one routine the same skill can
  // be called from several steps; that is still one routine using it.
  for (const routine of routines) {
    if (!routine.enabled) continue
    const counted = new Set<string>()
    for (const step of routine.steps) {
      const skillName = step.toolRef
      if (!skillName || counted.has(skillName)) continue
      counted.add(skillName)
      bump(skillName, 'routines')
    }
  }

  return usage
}

const pluralize = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

export const describeSkillUsage = (usage: SkillUsage): string => {
  if (usage.directives === 0 && usage.routines === 0) {
    return 'Not used by a directive or routine'
  }
  const parts: string[] = []
  if (usage.directives > 0) parts.push(pluralize(usage.directives, 'directive'))
  if (usage.routines > 0) parts.push(pluralize(usage.routines, 'routine'))
  return `Used by ${parts.join(' and ')}`
}
