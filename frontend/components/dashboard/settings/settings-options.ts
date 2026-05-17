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
    label: 'Semantic',
    description:
      'Uses embedding similarity over sentence windows to find semantic boundaries.',
  },
  {
    value: 'recursive_text',
    label: 'Recursive Text',
    description:
      'Uses paragraph, sentence, punctuation, word, and character boundaries to avoid awkward cuts where possible.',
  },
]
