import type { IngestionSettings } from '@/lib/api'

export const chunkingStrategyOptions: Array<{
  value: IngestionSettings['chunkingStrategy']
  label: string
  description: string
}> = [
  {
    value: 'fixed_window',
    label: 'Fixed Window',
    description: 'Uses the current overlapping fixed-size chunking behavior.',
  },
  {
    value: 'structured_semantic',
    label: 'Structured Semantic',
    description:
      'Uses headings, paragraphs, lists, tables, code fences, and FAQ pairs before merging adjacent blocks by topic.',
  },
]

export const embeddingModelOptions: Array<{
  value: IngestionSettings['embeddingModel']
  label: string
  description: string
}> = [
  {
    value: 'text-embedding-3-small',
    label: 'OpenAI text-embedding-3-small',
    description: 'Balanced default for most workspaces.',
  },
  {
    value: 'text-embedding-3-large',
    label: 'OpenAI text-embedding-3-large',
    description: 'Higher-capacity embeddings stored at the workspace vector size.',
  },
  {
    value: 'text-embedding-ada-002',
    label: 'OpenAI text-embedding-ada-002',
    description: 'Legacy-compatible embedding model for older indexes.',
  },
  {
    value: 'gemini-embedding-001',
    label: 'Google Gemini Embedding',
    description: 'Google embedding model stored at the workspace vector size.',
  },
]
