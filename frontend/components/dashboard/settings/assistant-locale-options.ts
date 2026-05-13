import { normalizeLocaleTag } from '@/lib/locale'

export const ASSISTANT_GREETING_LOCALE_OPTIONS = [
  { label: 'English', tag: 'en' },
  { label: 'Italian', tag: 'it' },
  { label: 'Spanish', tag: 'es' },
  { label: 'French', tag: 'fr' },
  { label: 'German', tag: 'de' },
  { label: 'Portuguese', tag: 'pt' },
  { label: 'Dutch', tag: 'nl' },
  { label: 'Swedish', tag: 'sv' },
  { label: 'Norwegian', tag: 'no' },
  { label: 'Danish', tag: 'da' },
  { label: 'Finnish', tag: 'fi' },
  { label: 'Estonian', tag: 'et' },
  { label: 'Russian', tag: 'ru' },
  { label: 'Japanese', tag: 'ja' },
  { label: 'Korean', tag: 'ko' },
  { label: 'Chinese', tag: 'zh' },
] as const

export const NO_GREETING_LOCALE_LABEL = 'No fallback'

export const getAssistantLocaleLabel = (tag: string | null) => {
  if (!tag) {
    return NO_GREETING_LOCALE_LABEL
  }

  return ASSISTANT_GREETING_LOCALE_OPTIONS.find((option) => option.tag === tag)?.label ?? tag
}

export const resolveAssistantLocaleInput = (value: string) => {
  const trimmed = value.trim()
  const normalized = trimmed.toLowerCase()
  if (!trimmed || normalized === NO_GREETING_LOCALE_LABEL.toLowerCase()) {
    return null
  }

  const configuredOption = ASSISTANT_GREETING_LOCALE_OPTIONS.find(
    (option) => option.label.toLowerCase() === normalized || option.tag.toLowerCase() === normalized,
  )
  if (configuredOption) {
    return configuredOption.tag
  }

  return normalizeLocaleTag(trimmed) ?? undefined
}
