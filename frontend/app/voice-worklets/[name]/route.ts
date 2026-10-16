import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const runtime = 'nodejs'

/**
 * The audio worklets the voice client loads during a call, served from the app host so the chat
 * frame's script policy (its own origin only) admits them. Each name maps to one file of an
 * installed package, so the served code is always the version the client was built against.
 */
const WORKLET_FILES: Record<string, readonly string[]> = {
  'raw-audio-processor.js': ['@elevenlabs', 'client', 'worklets', 'rawAudioProcessor.js'],
  'audio-concat-processor.js': ['@elevenlabs', 'client', 'worklets', 'audioConcatProcessor.js'],
  // The resampler a browser without the microphone sample-rate constraint needs.
  'libsamplerate.js': ['@alexanderolsen', 'libsamplerate-js', 'dist', 'libsamplerate.worklet.js'],
}

export async function GET(_request: Request, context: { params: Promise<{ name: string }> }) {
  const { name } = await context.params
  const segments = Object.hasOwn(WORKLET_FILES, name) ? WORKLET_FILES[name] : undefined
  if (!segments) {
    return new Response('Not found', { status: 404 })
  }
  const source = await readFile(join(process.cwd(), 'node_modules', ...segments), 'utf8')
  return new Response(source, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
