import chunkingStrategySource from '../../../docs/settings-docs/ingestion/chunking-strategy.md'
import fixedWindowChunkOverlapSource from '../../../docs/settings-docs/ingestion/fixed-window-chunk-overlap.md'
import fixedWindowChunkSizeSource from '../../../docs/settings-docs/ingestion/fixed-window-chunk-size.md'
import reprocessSource from '../../../docs/settings-docs/ingestion/reprocess-existing-documents.md'
import structuredMaxChunkSizeSource from '../../../docs/settings-docs/ingestion/structured-max-chunk-size.md'
import structuredMinChunkSizeSource from '../../../docs/settings-docs/ingestion/structured-min-chunk-size.md'
import answerSupportPolicySource from '../../../docs/settings-docs/retrieval/answer-support-policy.md'
import citationDisplayEnabledSource from '../../../docs/settings-docs/retrieval/citation-display-enabled.md'
import customInstructionSource from '../../../docs/settings-docs/retrieval/custom-instruction.md'
import lexicalRewriteInstructionsSource from '../../../docs/settings-docs/retrieval/lexical-rewrite-instructions.md'
import metadataEffectSource from '../../../docs/settings-docs/retrieval/metadata-effect.md'
import metadataEnabledSource from '../../../docs/settings-docs/retrieval/metadata-enabled.md'
import metadataKeySource from '../../../docs/settings-docs/retrieval/metadata-key.md'
import metadataOperatorSource from '../../../docs/settings-docs/retrieval/metadata-operator.md'
import metadataRulesSource from '../../../docs/settings-docs/retrieval/metadata-rules.md'
import metadataValueSource from '../../../docs/settings-docs/retrieval/metadata-value.md'
import metadataValueTypeSource from '../../../docs/settings-docs/retrieval/metadata-value-type.md'
import queryRewriteEnabledSource from '../../../docs/settings-docs/retrieval/query-rewrite-enabled.md'
import rerankEnabledSource from '../../../docs/settings-docs/retrieval/rerank-enabled.md'
import rerankTopKSource from '../../../docs/settings-docs/retrieval/rerank-top-k.md'
import semanticRewriteInstructionsSource from '../../../docs/settings-docs/retrieval/semantic-rewrite-instructions.md'
import similarityThresholdSource from '../../../docs/settings-docs/retrieval/similarity-threshold.md'
import vectorTopKSource from '../../../docs/settings-docs/retrieval/vector-top-k.md'
import warmthLevelSource from '../../../docs/settings-docs/retrieval/warmth-level.md'

export interface SettingDoc {
  label: string
  summary: string
  details: string
}

const normalizeSection = (value: string) => value.trim().replace(/\n{3,}/g, '\n\n')

const parseSettingDoc = (source: string): SettingDoc => {
  const normalized = source.trim()
  const labelMatch = normalized.match(/^#\s+(.+)$/m)
  const summaryMatch = normalized.match(/^##\s+Summary\s*\n+([\s\S]*?)(?=^##\s+|$)/m)
  const detailsMatch =
    normalized.match(/^##\s+Details\s*\n+([\s\S]*?)(?=^##\s+|$)/m) ??
    normalized.match(/^##\s+Tooltip\s*\n+([\s\S]*?)(?=^##\s+|$)/m)

  if (!labelMatch || !summaryMatch || !detailsMatch) {
    throw new Error('Invalid setting doc format. Expected # heading plus ## Summary and ## Details sections.')
  }

  return {
    label: normalizeSection(labelMatch[1]),
    summary: normalizeSection(summaryMatch[1]),
    details: normalizeSection(detailsMatch[1]),
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
  warmthLevel: parseSettingDoc(warmthLevelSource),
  answerSupportPolicy: parseSettingDoc(answerSupportPolicySource),
  citationDisplayEnabled: parseSettingDoc(citationDisplayEnabledSource),
  customInstruction: parseSettingDoc(customInstructionSource),
  metadataKey: parseSettingDoc(metadataKeySource),
  metadataValueType: parseSettingDoc(metadataValueTypeSource),
  metadataValue: parseSettingDoc(metadataValueSource),
  metadataOperator: parseSettingDoc(metadataOperatorSource),
  metadataEffect: parseSettingDoc(metadataEffectSource),
  metadataEnabled: parseSettingDoc(metadataEnabledSource),
} satisfies Record<string, SettingDoc>
