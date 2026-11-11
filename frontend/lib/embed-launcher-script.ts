import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { BUILT_IN_EMBED_LOCALE_PACKS } from '@/lib/embed-locale-packs'
import { COPY_OVERRIDE_KEYS } from '@/lib/embed-widget'

// The launcher is one plain script served to third-party pages, so it cannot
// import a module. It carries markers instead, and serving it fills them from
// the typed modules: the built-in locale packs and the copy keys it forwards
// to the iframe. The filled script stays static and edge-cacheable.
const BUILT_IN_LOCALE_COPY_MARKER = '/* @radioso:built-in-locale-copy */ {}'
const COPY_OVERRIDE_KEYS_MARKER = '/* @radioso:copy-override-keys */ []'

// `proactiveGreetingTeaser` is launcher-only: the teaser bubble beside the button.
const LAUNCHER_COPY_OVERRIDE_KEYS = [...COPY_OVERRIDE_KEYS, 'proactiveGreetingTeaser']

const fillMarker = (source: string, marker: string, value: unknown) => {
  if (!source.includes(marker)) {
    throw new Error(`embed launcher source is missing the ${marker} marker`)
  }
  // A replacer function, so `$` sequences in translated copy stay literal.
  return source.replace(marker, () => JSON.stringify(value))
}

export const renderEmbedLauncherScript = (source: string) =>
  fillMarker(
    fillMarker(source, BUILT_IN_LOCALE_COPY_MARKER, BUILT_IN_EMBED_LOCALE_PACKS),
    COPY_OVERRIDE_KEYS_MARKER,
    LAUNCHER_COPY_OVERRIDE_KEYS,
  )

export const readEmbedLauncherScript = async () =>
  renderEmbedLauncherScript(await readFile(join(process.cwd(), 'lib/radioso-embed-launcher.js'), 'utf8'))
