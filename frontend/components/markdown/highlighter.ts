import type { CSSProperties } from 'react'
import type { HighlighterCore, ThemedTokenWithVariants, TokenStyles } from 'shiki/core'

export const SUPPORTED_LANGUAGES = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'json',
  'bash',
  'sh',
  'python',
  'sql',
  'md',
  'yaml',
  'html',
  'css',
  'diff',
  'plaintext',
] as const

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

export type HighlightedCodeToken = {
  content: string
  style?: CSSProperties & Record<`--${string}`, string | undefined>
}

export type HighlightedCode = HighlightedCodeToken[][]

const LANGUAGE_ALIASES: Record<string, SupportedLanguage> = {
  typescript: 'ts',
  javascript: 'js',
  shell: 'bash',
  zsh: 'bash',
  py: 'python',
  yml: 'yaml',
  markdown: 'md',
  text: 'plaintext',
  '': 'plaintext',
}

export const resolveLanguage = (input?: string): SupportedLanguage => {
  if (!input) {
    return 'plaintext'
  }
  const normalized = input.toLowerCase().trim()
  const aliased = LANGUAGE_ALIASES[normalized]
  if (aliased) {
    return aliased
  }
  if ((SUPPORTED_LANGUAGES as readonly string[]).includes(normalized)) {
    return normalized as SupportedLanguage
  }
  return 'plaintext'
}

let highlighterPromise: Promise<HighlighterCore> | null = null

export const getHighlighter = (): Promise<HighlighterCore> => {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript'),
      ])

      return createHighlighterCore({
        engine: createJavaScriptRegexEngine(),
        themes: [
          import('shiki/themes/github-light.mjs'),
          import('shiki/themes/github-dark.mjs'),
        ],
        langs: [
          import('shiki/langs/typescript.mjs'),
          import('shiki/langs/tsx.mjs'),
          import('shiki/langs/javascript.mjs'),
          import('shiki/langs/jsx.mjs'),
          import('shiki/langs/json.mjs'),
          import('shiki/langs/bash.mjs'),
          import('shiki/langs/python.mjs'),
          import('shiki/langs/sql.mjs'),
          import('shiki/langs/markdown.mjs'),
          import('shiki/langs/yaml.mjs'),
          import('shiki/langs/html.mjs'),
          import('shiki/langs/css.mjs'),
          import('shiki/langs/diff.mjs'),
        ],
      })
    })()
  }
  return highlighterPromise
}

const FONT_STYLE_ITALIC = 1
const FONT_STYLE_BOLD = 2
const FONT_STYLE_UNDERLINE = 4
const FONT_STYLE_STRIKETHROUGH = 8

const sanitizeThemeColor = (value?: string) =>
  value && /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(value) ? value : undefined

const tokenStyle = (light?: TokenStyles, dark?: TokenStyles): HighlightedCodeToken['style'] => {
  const fontStyle = light?.fontStyle ?? dark?.fontStyle ?? 0
  const decorations: Array<'underline' | 'line-through'> = []
  const lightColor = sanitizeThemeColor(light?.color)
  const darkColor = sanitizeThemeColor(dark?.color)
  const lightBackgroundColor = sanitizeThemeColor(light?.bgColor)
  const darkBackgroundColor = sanitizeThemeColor(dark?.bgColor)

  if ((fontStyle & FONT_STYLE_UNDERLINE) !== 0) {
    decorations.push('underline')
  }
  if ((fontStyle & FONT_STYLE_STRIKETHROUGH) !== 0) {
    decorations.push('line-through')
  }

  return {
    '--code-token-light': lightColor,
    '--code-token-dark': darkColor,
    '--code-token-light-bg': lightBackgroundColor,
    '--code-token-dark-bg': darkBackgroundColor,
    color: lightColor ? 'var(--code-token-light)' : undefined,
    backgroundColor: lightBackgroundColor ? 'var(--code-token-light-bg)' : undefined,
    fontStyle: (fontStyle & FONT_STYLE_ITALIC) !== 0 ? 'italic' : undefined,
    fontWeight: (fontStyle & FONT_STYLE_BOLD) !== 0 ? 'bold' : undefined,
    textDecorationLine: decorations.length > 0
      ? decorations.join(' ') as CSSProperties['textDecorationLine']
      : undefined,
  }
}

const toHighlightedToken = (token: ThemedTokenWithVariants): HighlightedCodeToken => {
  const light = token.variants.light
  const dark = token.variants.dark

  return {
    content: token.content,
    style: tokenStyle(light, dark),
  }
}

export const highlightCode = async (
  code: string,
  lang: SupportedLanguage,
): Promise<HighlightedCode> => {
  const highlighter = await getHighlighter()
  return highlighter
    .codeToTokensWithThemes(code, {
      lang,
      themes: { light: 'github-light', dark: 'github-dark' },
    })
    .map((line) => line.map(toHighlightedToken))
}
