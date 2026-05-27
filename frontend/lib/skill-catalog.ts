'use client'

import { useEffect, useState } from 'react'

import { skillsApi, type PublicChatIntakeAction, type SkillCatalogEntry } from './api'
import type { SkillCatalogDisplayEntry } from './skill-display'

export const useSkillCatalog = (refreshKey?: string | null): SkillCatalogEntry[] => {
  const [skillCatalog, setSkillCatalog] = useState<SkillCatalogEntry[]>([])

  useEffect(() => {
    let cancelled = false

    void skillsApi.list()
      .then((response) => {
        if (!cancelled) {
          setSkillCatalog(response.skills)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSkillCatalog([])
        }
      })

    return () => {
      cancelled = true
    }
  }, [refreshKey])

  return skillCatalog
}

export const skillCatalogFromPublicIntakeActions = (
  actions: readonly PublicChatIntakeAction[],
): SkillCatalogDisplayEntry[] =>
  actions.map((action) => ({
    name: action.skillName,
    display: action.display,
  }))
