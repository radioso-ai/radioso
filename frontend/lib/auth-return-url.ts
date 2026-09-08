const applicationOrigin = 'https://radioso.invalid'

/**
 * Keeps post-auth navigation inside this application. Callers pass a relative
 * path, never an externally supplied absolute URL.
 */
export const normalizeSameOriginReturnPath = (value: string | null | undefined): string | undefined => {
  if (!value?.startsWith('/')) {
    return undefined
  }

  try {
    const parsed = new URL(value, applicationOrigin)
    if (parsed.origin !== applicationOrigin) {
      return undefined
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return undefined
  }
}
