import type { HighlighterCore } from 'shiki/core'

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
