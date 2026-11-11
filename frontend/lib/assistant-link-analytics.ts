// Outbound links in an assistant reply: tag them with the assistant as the UTM
// medium, and reduce a clicked destination to the origin and path analytics keeps.
const toAssistantUtmMedium = (assistantName?: string | null) => {
  const normalized = assistantName
    ?.trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')

  return `${normalized || 'assistant'}_agent`
}

export const appendAssistantLinkUtm = (href: string, assistantName?: string | null) => {
  try {
    const url = new URL(href)
    if (!['http:', 'https:'].includes(url.protocol)) {
      return href
    }

    url.searchParams.set('utm_source', 'radioso')
    url.searchParams.set('utm_medium', toAssistantUtmMedium(assistantName))
    return url.toString()
  } catch {
    return href
  }
}

export const sanitizeDestinationForAnalytics = (destinationUrl?: string) => {
  if (!destinationUrl) {
    return {}
  }

  try {
    const url = new URL(destinationUrl)
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) {
      return {}
    }

    return {
      destinationOrigin: url.protocol === 'mailto:' ? 'mailto:' : url.origin,
      destinationPath: url.protocol === 'mailto:' ? '' : url.pathname,
    }
  } catch {
    return {}
  }
}
