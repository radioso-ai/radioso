import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const runtime = 'nodejs'

/**
 * The audio worklets the voice client loads during a call, served from the app host so the chat
 * frame's script policy (its own origin only) admits them. Each name maps to one file of an
 * installed package, so the served code is the version the client was built against; the ETag
 * follows the file, so a browser revalidates instead of keeping a worklet from an older client.
 */
const WORKLET_FILES: Record<string, readonly string[]> = {
  'raw-audio-processor.js': ['@elevenlabs', 'client', 'worklets', 'rawAudioProcessor.js'],
  'audio-concat-processor.js': ['@elevenlabs', 'client', 'worklets', 'audioConcatProcessor.js'],
  // The resampler a browser without the microphone sample-rate constraint needs. Its version is
  // the one the client names for its CDN fallback (`addLibsamplerateModule.js`); keep them equal.
  'libsamplerate.js': ['@alexanderolsen', 'libsamplerate-js', 'dist', 'libsamplerate.worklet.js'],
}

const loaded = new Map<string, Promise<{ source: string; etag: string }>>()

const loadWorklet = (name: string, segments: readonly string[]) => {
  let worklet = loaded.get(name)
  if (!worklet) {
    worklet = readFile(join(process.cwd(), 'node_modules', ...segments), 'utf8').then((source) => ({
      source,
      etag: `"${createHash('sha256').update(source).digest('base64url').slice(0, 27)}"`,
    }))
    worklet.catch(() => loaded.delete(name))
    loaded.set(name, worklet)
  }
  return worklet
}

/**
 * Whether an `If-None-Match` header names this ETag: it may list several, and a proxy may have
 * weakened any of them with `W/`, which still matches for a GET.
 */
const namesEtag = (ifNoneMatch: string | null, etag: string): boolean => {
  if (!ifNoneMatch) return false
  return ifNoneMatch.split(',').some((candidate) => {
    const tag = candidate.trim()
    return tag === '*' || tag.replace(/^W\//, '') === etag
  })
}

export async function GET(request: Request, context: { params: Promise<{ name: string }> }) {
  const { name } = await context.params
  const segments = Object.hasOwn(WORKLET_FILES, name) ? WORKLET_FILES[name] : undefined
  if (!segments) {
    return new Response('Not found', { status: 404 })
  }
  const { source, etag } = await loadWorklet(name, segments)
  const headers = {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Cache-Control': 'public, no-cache',
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
  }
  if (namesEtag(request.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers })
  }
  return new Response(source, { headers })
}
