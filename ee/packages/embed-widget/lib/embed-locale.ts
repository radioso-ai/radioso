export const resolveEmbedLocaleSearchParam = (locale?: string | string[]) =>
  Array.isArray(locale) ? locale[0] : locale
