import type { RoutineDefinition, RoutineDefinitionStatus } from './api-types'

export type RoutineLineageState = 'published' | 'draft-only' | 'draft-with-archived' | 'archived' | 'superseded'

export type RoutineLineageGroup = {
  lineageId: string
  name: string
  triggerDescription: string
  state: RoutineLineageState
  displayRoutine: RoutineDefinition
  activeRoutine: RoutineDefinition | null
  pendingDraft: RoutineDefinition | null
  versions: RoutineDefinition[]
}

export type RoutineLineagePartition = {
  active: RoutineLineageGroup[]
  archived: RoutineLineageGroup[]
}

const statusRank: Record<RoutineDefinitionStatus, number> = {
  draft: 4,
  published: 3,
  archived: 2,
  superseded: 1,
}

const byNewestVersion = (left: RoutineDefinition, right: RoutineDefinition) =>
  right.version - left.version
  || statusRank[right.status] - statusRank[left.status]
  || right.updatedAt.localeCompare(left.updatedAt)

const byLineageName = (left: RoutineLineageGroup, right: RoutineLineageGroup) =>
  left.name.localeCompare(right.name) || left.displayRoutine.version - right.displayRoutine.version

const newestOfStatus = (versions: RoutineDefinition[], status: RoutineDefinitionStatus) =>
  versions.find((routine) => routine.status === status) ?? null

const stateFor = (versions: RoutineDefinition[]): RoutineLineageState => {
  if (versions.some((routine) => routine.status === 'published')) return 'published'
  if (versions.some((routine) => routine.status === 'draft')) {
    return versions.some((routine) => routine.status === 'archived') ? 'draft-with-archived' : 'draft-only'
  }
  if (versions.some((routine) => routine.status === 'archived')) return 'archived'
  return 'superseded'
}

export const groupRoutineLineages = (routines: RoutineDefinition[]): RoutineLineagePartition => {
  const byLineage = new Map<string, RoutineDefinition[]>()
  for (const routine of routines) {
    const current = byLineage.get(routine.lineageId) ?? []
    current.push(routine)
    byLineage.set(routine.lineageId, current)
  }

  const groups = [...byLineage.entries()].map(([lineageId, lineageRoutines]): RoutineLineageGroup => {
    const versions = [...lineageRoutines].sort(byNewestVersion)
    const published = newestOfStatus(versions, 'published')
    const draft = newestOfStatus(versions, 'draft')
    const archived = newestOfStatus(versions, 'archived')
    const displayRoutine = published ?? draft ?? archived ?? versions[0]

    return {
      lineageId,
      name: displayRoutine.name,
      triggerDescription: displayRoutine.activation.triggerDescription,
      state: stateFor(versions),
      displayRoutine,
      activeRoutine: published ?? archived,
      pendingDraft: draft && published ? draft : null,
      versions,
    }
  }).sort(byLineageName)

  return {
    active: groups.filter((group) => group.state !== 'archived'),
    archived: groups.filter((group) => group.state === 'archived'),
  }
}

export const getRoutineLineageVersions = (
  routines: RoutineDefinition[],
  lineageId: string | null | undefined,
): RoutineDefinition[] => {
  if (!lineageId) return []
  return routines
    .filter((routine) => routine.lineageId === lineageId)
    .sort(byNewestVersion)
}
