'use client'

import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control'

export type ExampleLanguage = 'curl' | 'typescript'

const LANGUAGE_OPTIONS: readonly SegmentedControlOption<ExampleLanguage>[] = [
  { value: 'curl', label: 'curl' },
  { value: 'typescript', label: 'TypeScript' },
]

export function ExampleSelector({
  value,
  onChange,
}: {
  value: ExampleLanguage
  onChange: (value: ExampleLanguage) => void
}) {
  return <SegmentedControl value={value} onValueChange={onChange} options={LANGUAGE_OPTIONS} />
}
