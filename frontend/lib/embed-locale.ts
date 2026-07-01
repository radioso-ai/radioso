import { parseAcceptLanguageLocales, pickBuiltInEmbedLocale } from '@/lib/embed-locale-packs'

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
