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
