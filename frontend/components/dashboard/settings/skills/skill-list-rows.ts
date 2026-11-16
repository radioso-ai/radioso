import type { AgentSkill, SkillCapabilityDescriptor } from '@/lib/api-skills'
import { formatCapabilityLabel } from './skill-form-model'
import { describeSkillUsage, NO_SKILL_USAGE, type SkillUsage } from './skill-usage'

export const skillRowDomId = (skillId: string): string => `skill-${skillId}`
export const builtInSkillRowDomId = (skillName: string): string => `built-in-skill-${skillName}`

// Null for a capability configured entirely inside the skill, which has no target to name.
export const skillTargetLabel = (skill: AgentSkill, capabilities: readonly SkillCapabilityDescriptor[]): string | null => {
  const capability = capabilities.find((candidate) => candidate.id === skill.capability)
  if (capability && !(capability.requiresTarget ?? true)) {
    return null
  }
  const target = capability?.targets.find((candidate) => candidate.id === skill.target.id)
  return target?.label ?? skill.target.id ?? skill.target.kind
}

// A skill's row says what it does and where, then who uses it. The usage part is left out while
// the referencing directives and routines are unread, so a used skill is never called unused.
export const skillRowSummary = (
  skill: AgentSkill,
  capabilities: readonly SkillCapabilityDescriptor[],
  usage: Map<string, SkillUsage> | null,
): string => {
  const target = skillTargetLabel(skill, capabilities)
  return [
    formatCapabilityLabel(skill.capability),
    ...(target ? [target] : []),
    ...(usage ? [describeSkillUsage(usage.get(skill.name) ?? NO_SKILL_USAGE)] : []),
  ].join(' · ')
}
