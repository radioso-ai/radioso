import { parseAcceptLanguageLocales, pickBuiltInEmbedLocale } from '@/lib/embed-locale-packs'
import { normalizeWebsiteEmbedLocale } from '@/lib/embed-widget'
import type { WebsiteEmbedPageContext } from '@/lib/api'

export const resolveEmbedLocaleSearchParam = (locale?: string | string[]) =>
  Array.isArray(locale) ? locale[0] : locale

// Resolve the visitor locale for a public embed surface (public link, full-page
// embed). An explicit `?locale` param is authoritative; otherwise fall back to
// the request's `Accept-Language`, preferring the first language that has a
// built-in translation pack so the chrome localizes, else the top language so
// the assistant still gets a reply-language hint. Undefined keeps the English
// baseline. Standalone surfaces need this because they do not load the launcher
// script, which is where visitor-language detection otherwise happens.
export const resolveEmbedLocaleOverride = ({
  param,
  acceptLanguage,
}: {
  param?: string | string[]
  acceptLanguage?: string | null
}): string | undefined => {
  const explicit = resolveEmbedLocaleSearchParam(param)
  if (explicit) {
    return explicit
  }
  const candidates = parseAcceptLanguageLocales(acceptLanguage)
  return pickBuiltInEmbedLocale(candidates) ?? candidates[0]
}

const isValidLocaleHint = (value: string | null | undefined): value is string => {
  if (!value) {
    return false
  }

  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= 35 && normalizeWebsiteEmbedLocale(trimmed) !== null
}

// The reply-language hint a public chat sends: the host's locale override, else
// the page's language, else the browser's. Undefined when none is a valid tag.
export const resolveAnonymousChatBootstrapLocale = ({
  localeOverride,
  pageContext,
}: {
  localeOverride?: string | null
  pageContext?: WebsiteEmbedPageContext | null
  browserLocales?: readonly string[]
}) => {
  if (isValidLocaleHint(localeOverride)) {
    return localeOverride.trim()
  }

  if (isValidLocaleHint(pageContext?.pageLocale)) {
    return pageContext.pageLocale.trim()
  }

  if (isValidLocaleHint(pageContext?.browserLocale)) {
    return pageContext.browserLocale.trim()
  }

  return undefined
}
