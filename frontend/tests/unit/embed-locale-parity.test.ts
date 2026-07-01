import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import vm from 'node:vm'

import { beforeAll, describe, expect, it } from 'vitest'

import { BUILT_IN_EMBED_LOCALE_PACKS, TRANSLATABLE_COPY_KEYS } from '@/lib/embed-locale-packs'
import { COPY_OVERRIDE_KEYS } from '@/lib/embed-widget'

// The launcher (`radioso-embed-launcher.js`) is served raw and cannot import a
// module, so it keeps its own inline copy of the locale packs. This test is the
// guard that keeps that inline copy identical to the typed source of truth in
// `lib/embed-locale-packs.ts` — the guard whose absence previously let the
// launcher silently drop translated keys.

const sliceLiteral = (source: string, name: string, openChar: '{' | '[') => {
  const start = source.indexOf(`const ${name} = `)
  if (start === -1) {
    throw new Error(`could not find ${name} in launcher source`)
  }
  const open = source.indexOf(openChar, start)
  const close = openChar === '[' ? ']' : '}'
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === openChar) depth += 1
    else if (source[index] === close) {
      depth -= 1
      if (depth === 0) {
        return vm.runInNewContext(`(${source.slice(open, index + 1)})`)
      }
    }
  }
  throw new Error(`unterminated ${name} literal in launcher source`)
}

describe('launcher locale-pack parity', () => {
  let launcherPacks: Record<string, Record<string, string>>
  let launcherCopyKeys: string[]

  beforeAll(async () => {
    const source = await readFile(join(process.cwd(), 'lib/radioso-embed-launcher.js'), 'utf8')
    launcherPacks = sliceLiteral(source, 'builtInLocaleCopy', '{')
    launcherCopyKeys = sliceLiteral(source, 'copyOverrideKeys', '[')
  })

  it('covers the same locales as the typed source of truth', () => {
    expect(Object.keys(launcherPacks).sort()).toEqual(Object.keys(BUILT_IN_EMBED_LOCALE_PACKS).sort())
  })

  it('mirrors the typed packs key-for-key and value-for-value', () => {
    for (const [locale, pack] of Object.entries(BUILT_IN_EMBED_LOCALE_PACKS)) {
      expect(launcherPacks[locale], `launcher pack ${locale}`).toEqual(pack)
    }
  })

  it('whitelists every key its packs use so none are stripped before the iframe', () => {
    const packKeys = new Set<string>()
    for (const pack of Object.values(launcherPacks)) {
      Object.keys(pack).forEach((key) => packKeys.add(key))
    }
    for (const key of packKeys) {
      expect(launcherCopyKeys, `copyOverrideKeys missing ${key}`).toContain(key)
    }
  })

  it('whitelists every translatable in-frame copy key for operator packs', () => {
    for (const key of TRANSLATABLE_COPY_KEYS) {
      expect(launcherCopyKeys, `copyOverrideKeys missing ${key}`).toContain(key)
    }
  })

  it('only whitelists real copy keys plus the launcher-only teaser', () => {
    const allowed = new Set<string>([...COPY_OVERRIDE_KEYS, 'proactiveGreetingTeaser'])
    for (const key of launcherCopyKeys) {
      expect(allowed, `unexpected launcher copy key ${key}`).toContain(key)
    }
  })
})
