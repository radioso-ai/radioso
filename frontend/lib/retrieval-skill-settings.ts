import type { RetrievalMetadataRule } from './api-types'

export const RETRIEVAL_ANSWER_SKILL_NAME = 'retrieval.answer'

export type RetrievalStrategy = 'fixed' | 'reasoning' | 'auto'

export interface RetrievalSkillSettingsOverride {
  queryRewriteEnabled?: boolean
  semanticRewriteInstructions?: string
  lexicalRewriteInstructions?: string
  suggestedQuestionsEnabled?: boolean
  suggestedQuestionsCount?: number
  retrievalStrategy?: RetrievalStrategy
  vectorTopK?: number
  similarityThreshold?: number
  rerankEnabled?: boolean
  rerankTopK?: number
  metadataRules?: RetrievalMetadataRule[]
}

export type AgentSkillSettingsMap = Record<string, unknown>

const knownRetrievalSkillFields = [
  'queryRewriteEnabled',
  'semanticRewriteInstructions',
  'lexicalRewriteInstructions',
  'suggestedQuestionsEnabled',
  'suggestedQuestionsCount',
  'retrievalStrategy',
  'vectorTopK',
  'similarityThreshold',
  'rerankEnabled',
  'rerankTopK',
  'metadataRules',
] as const

const retrievalStrategies = new Set<RetrievalStrategy>(['fixed', 'reasoning', 'auto'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const readRetrievalSkillSettingsOverride = (
  skillSettings: AgentSkillSettingsMap | undefined,
): RetrievalSkillSettingsOverride => {
  const raw = skillSettings?.[RETRIEVAL_ANSWER_SKILL_NAME]
  if (!isRecord(raw)) {
    return {}
  }

  const next: RetrievalSkillSettingsOverride = {}
  if (typeof raw.queryRewriteEnabled === 'boolean') next.queryRewriteEnabled = raw.queryRewriteEnabled
  if (typeof raw.semanticRewriteInstructions === 'string') next.semanticRewriteInstructions = raw.semanticRewriteInstructions
  if (typeof raw.lexicalRewriteInstructions === 'string') next.lexicalRewriteInstructions = raw.lexicalRewriteInstructions
  if (typeof raw.suggestedQuestionsEnabled === 'boolean') next.suggestedQuestionsEnabled = raw.suggestedQuestionsEnabled
  if (typeof raw.suggestedQuestionsCount === 'number' && Number.isInteger(raw.suggestedQuestionsCount)) {
    next.suggestedQuestionsCount = raw.suggestedQuestionsCount
  }
  if (typeof raw.retrievalStrategy === 'string' && retrievalStrategies.has(raw.retrievalStrategy as RetrievalStrategy)) {
    next.retrievalStrategy = raw.retrievalStrategy as RetrievalStrategy
  }
  if (typeof raw.vectorTopK === 'number' && Number.isInteger(raw.vectorTopK)) next.vectorTopK = raw.vectorTopK
  if (typeof raw.similarityThreshold === 'number' && raw.similarityThreshold >= 0 && raw.similarityThreshold <= 1) {
    next.similarityThreshold = raw.similarityThreshold
  }
  if (typeof raw.rerankEnabled === 'boolean') next.rerankEnabled = raw.rerankEnabled
  if (typeof raw.rerankTopK === 'number' && Number.isInteger(raw.rerankTopK)) next.rerankTopK = raw.rerankTopK
  if (Array.isArray(raw.metadataRules)) next.metadataRules = raw.metadataRules as RetrievalMetadataRule[]
  return next
}

export const writeRetrievalSkillSettingsOverride = (
  skillSettings: AgentSkillSettingsMap | undefined,
  override: RetrievalSkillSettingsOverride,
): AgentSkillSettingsMap => {
  const next: AgentSkillSettingsMap = { ...(skillSettings ?? {}) }
  const existing = next[RETRIEVAL_ANSWER_SKILL_NAME]
  const retrievalAnswer = isRecord(existing) ? { ...existing } : {}

  for (const field of knownRetrievalSkillFields) {
    delete retrievalAnswer[field]
  }

  const merged = {
    ...retrievalAnswer,
    ...override,
  }

  if (Object.keys(merged).length === 0) {
    delete next[RETRIEVAL_ANSWER_SKILL_NAME]
    return next
  }

  next[RETRIEVAL_ANSWER_SKILL_NAME] = merged
  return next
}
