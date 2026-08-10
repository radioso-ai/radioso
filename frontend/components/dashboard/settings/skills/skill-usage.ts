// Which authored surfaces reference a skill. A skill nothing references never fires, and the
// registry is the only place that can say so.

export type SkillUsage = { directives: number; routines: number }

// The bindings and step references a usage count reads. Narrower than the full API types on
// purpose: the count does not care what else a directive or a routine carries.
export type SkillUsageDirective = { binding?: { skillName?: string | null } | null }
export type SkillUsageRoutine = {
  lineageId: string
  status: string
  steps: readonly { toolRef?: string | null }[]
}

export const NO_SKILL_USAGE: SkillUsage = { directives: 0, routines: 0 }

// A routine lineage is one routine to an author: its draft and its published version are the same
// procedure at two lifecycle points, and superseded or archived versions cannot fire at all.
const isLiveRoutine = (routine: SkillUsageRoutine): boolean =>
  routine.status === 'draft' || routine.status === 'published'

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

  const countedLineages = new Map<string, Set<string>>()
  for (const routine of routines) {
    if (!isLiveRoutine(routine)) continue
    for (const step of routine.steps) {
      const skillName = step.toolRef
      if (!skillName) continue
      const lineages = countedLineages.get(skillName) ?? new Set<string>()
      if (lineages.has(routine.lineageId)) continue
      lineages.add(routine.lineageId)
      countedLineages.set(skillName, lineages)
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
