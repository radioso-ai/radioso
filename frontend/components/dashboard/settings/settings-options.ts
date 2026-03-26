import type { IngestionSettings, RetrievalSettings } from '@/lib/api'

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

export const attributeFamilyOptions: Array<{
  family: RetrievalSettings['attributeControls'][number]['family']
  label: string
  description: string
}> = [
  {
    family: 'date_point',
    label: 'Single Dates',
    description: 'Use exact dates such as deadlines, departures, or scheduled days.',
  },
  {
    family: 'date_range',
    label: 'Date Ranges',
    description: 'Use spans such as retreat windows, event ranges, or booking periods.',
  },
  {
    family: 'money_value',
    label: 'Prices',
    description: 'Use monetary values such as prices, fees, or budget thresholds.',
  },
  {
    family: 'location',
    label: 'Locations',
    description: 'Use place names such as cities, countries, or venue references.',
  },
]

export const attributeModeLabels: Record<
  RetrievalSettings['attributeControls'][number]['mode'],
  { label: string; description: string }
> = {
  boost_only: {
    label: 'Boost Only',
    description: 'Prefer matching results without strictly excluding other candidates.',
  },
  hard_filter: {
    label: 'Hard Filter Eligible',
    description: 'Allow high-confidence matches to narrow results when the query is precise enough.',
  },
}
