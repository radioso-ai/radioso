import chunkingStrategySource from '../../../docs/settings-docs/ingestion/chunking-strategy.md'
import fixedWindowChunkOverlapSource from '../../../docs/settings-docs/ingestion/fixed-window-chunk-overlap.md'
import fixedWindowChunkSizeSource from '../../../docs/settings-docs/ingestion/fixed-window-chunk-size.md'
import reprocessSource from '../../../docs/settings-docs/ingestion/reprocess-existing-documents.md'
import structuredMaxChunkSizeSource from '../../../docs/settings-docs/ingestion/structured-max-chunk-size.md'
import structuredMinChunkSizeSource from '../../../docs/settings-docs/ingestion/structured-min-chunk-size.md'
import answerSupportValidationEnabledSource from '../../../docs/settings-docs/retrieval/answer-support-validation-enabled.md'
import citationDisplayEnabledSource from '../../../docs/settings-docs/retrieval/citation-display-enabled.md'
import conversationModeSource from '../../../docs/settings-docs/retrieval/conversation-mode.md'
import customInstructionSource from '../../../docs/settings-docs/retrieval/custom-instruction.md'
import lexicalRewriteInstructionsSource from '../../../docs/settings-docs/retrieval/lexical-rewrite-instructions.md'
import metadataEffectSource from '../../../docs/settings-docs/retrieval/metadata-effect.md'
import metadataDynamicDateSource from '../../../docs/settings-docs/retrieval/metadata-dynamic-date.md'
import metadataEnabledSource from '../../../docs/settings-docs/retrieval/metadata-enabled.md'
import metadataKeySource from '../../../docs/settings-docs/retrieval/metadata-key.md'
import metadataOperatorSource from '../../../docs/settings-docs/retrieval/metadata-operator.md'
import metadataRulesSource from '../../../docs/settings-docs/retrieval/metadata-rules.md'
import metadataTriggerInstructionSource from '../../../docs/settings-docs/retrieval/metadata-trigger-instruction.md'
import metadataTriggerModeSource from '../../../docs/settings-docs/retrieval/metadata-trigger-mode.md'
import metadataValueSource from '../../../docs/settings-docs/retrieval/metadata-value.md'
import metadataValueTypeSource from '../../../docs/settings-docs/retrieval/metadata-value-type.md'
import queryRewriteEnabledSource from '../../../docs/settings-docs/retrieval/query-rewrite-enabled.md'
import rerankEnabledSource from '../../../docs/settings-docs/retrieval/rerank-enabled.md'
import rerankTopKSource from '../../../docs/settings-docs/retrieval/rerank-top-k.md'
import semanticRewriteInstructionsSource from '../../../docs/settings-docs/retrieval/semantic-rewrite-instructions.md'
import suggestedQuestionsCountSource from '../../../docs/settings-docs/retrieval/suggested-questions-count.md'
import suggestedQuestionsEnabledSource from '../../../docs/settings-docs/retrieval/suggested-questions-enabled.md'
import similarityThresholdSource from '../../../docs/settings-docs/retrieval/similarity-threshold.md'
import vectorTopKSource from '../../../docs/settings-docs/retrieval/vector-top-k.md'

export interface SettingDoc {
  label: string
  summary: string
  details: string
}

const normalizeSection = (value: string) => value.trim().replace(/\n{3,}/g, '\n\n')

const extractSection = (source: string, heading: 'Summary' | 'Details' | 'Tooltip') => {
  const marker = `## ${heading}`
  const start = source.indexOf(marker)
  if (start < 0) {
    return null
  }

  const afterHeading = source.indexOf('\n', start)
  if (afterHeading < 0) {
    return ''
  }

  const remainder = source.slice(afterHeading + 1)
  const nextSectionIndex = remainder.search(/^##\s+/m)
  return nextSectionIndex >= 0 ? remainder.slice(0, nextSectionIndex) : remainder
}

const parseSettingDoc = (source: string): SettingDoc => {
  const normalized = source.trim()
  const labelMatch = normalized.match(/^#\s+(.+)$/m)
  const summary = extractSection(normalized, 'Summary')
  const details = extractSection(normalized, 'Details') ?? extractSection(normalized, 'Tooltip')

  if (!labelMatch || summary === null || details === null) {
    throw new Error('Invalid setting doc format. Expected # heading plus ## Summary and ## Details sections.')
  }

  return {
    label: normalizeSection(labelMatch[1]),
    summary: normalizeSection(summary),
    details: normalizeSection(details),
  }
}

export const ingestionSettingDocs = {
  chunkingStrategy: parseSettingDoc(chunkingStrategySource),
  fixedWindowChunkSize: parseSettingDoc(fixedWindowChunkSizeSource),
  fixedWindowChunkOverlap: parseSettingDoc(fixedWindowChunkOverlapSource),
  structuredMinChunkSize: parseSettingDoc(structuredMinChunkSizeSource),
  structuredMaxChunkSize: parseSettingDoc(structuredMaxChunkSizeSource),
  reprocess: parseSettingDoc(reprocessSource),
} satisfies Record<string, SettingDoc>

export const retrievalSettingDocs = {
  queryRewriteEnabled: parseSettingDoc(queryRewriteEnabledSource),
  semanticRewriteInstructions: parseSettingDoc(semanticRewriteInstructionsSource),
  lexicalRewriteInstructions: parseSettingDoc(lexicalRewriteInstructionsSource),
  vectorTopK: parseSettingDoc(vectorTopKSource),
  similarityThreshold: parseSettingDoc(similarityThresholdSource),
  metadataRules: parseSettingDoc(metadataRulesSource),
  rerankEnabled: parseSettingDoc(rerankEnabledSource),
  rerankTopK: parseSettingDoc(rerankTopKSource),
  conversationMode: parseSettingDoc(conversationModeSource),
  suggestedQuestionsEnabled: parseSettingDoc(suggestedQuestionsEnabledSource),
  suggestedQuestionsCount: parseSettingDoc(suggestedQuestionsCountSource),
  citationDisplayEnabled: parseSettingDoc(citationDisplayEnabledSource),
  answerSupportValidationEnabled: parseSettingDoc(answerSupportValidationEnabledSource),
  customInstruction: parseSettingDoc(customInstructionSource),
  metadataKey: parseSettingDoc(metadataKeySource),
  metadataValueType: parseSettingDoc(metadataValueTypeSource),
  metadataValue: parseSettingDoc(metadataValueSource),
  metadataOperator: parseSettingDoc(metadataOperatorSource),
  metadataEffect: parseSettingDoc(metadataEffectSource),
  metadataEnabled: parseSettingDoc(metadataEnabledSource),
  metadataDynamicDate: parseSettingDoc(metadataDynamicDateSource),
  metadataTriggerMode: parseSettingDoc(metadataTriggerModeSource),
  metadataTriggerInstruction: parseSettingDoc(metadataTriggerInstructionSource),
} satisfies Record<string, SettingDoc>
