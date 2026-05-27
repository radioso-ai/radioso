import { request } from './api-client'
import type { components } from '../../typescript-sdk/src/generated/types'

type ApiSchemas = components['schemas']

export type SkillCatalogEntry = ApiSchemas['SkillCatalogEntry']
export type SkillCatalogResponse = ApiSchemas['SkillCatalogResponse']
export type SkillDisplayMetadata = NonNullable<SkillCatalogEntry['display']>
export type SkillOwner = SkillCatalogEntry['owner']
export type SkillOutcomeDefinition = NonNullable<SkillCatalogEntry['outcomes']>[number]
export type SkillOutcomeStatus = SkillOutcomeDefinition['status']
export type SkillOutcomeTone = NonNullable<SkillOutcomeDefinition['tone']>

export const skillsApi = {
  async list(): Promise<SkillCatalogResponse> {
    return request<SkillCatalogResponse>('/skills', { method: 'GET' }, { withApiToken: true })
  },
}
