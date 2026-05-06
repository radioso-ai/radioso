const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|[0-9]{3}))?$/

export const normalizeLocaleTag = (value: string | null | undefined): string | null => {
  if (!value) {
    return null
  }

  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 35 || !LOCALE_PATTERN.test(trimmed)) {
    return null
  }

  return trimmed
}
