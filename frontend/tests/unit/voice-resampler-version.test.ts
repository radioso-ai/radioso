import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// The voice client loads its resampler from a CDN by default; the app host serves the installed
// package instead (`app/voice-worklets/[name]/route.ts`). The two must be the same version, so a
// client upgrade that moves its resampler moves the dependency with it.
describe('the voice resampler the app host serves', () => {
  it('is the version the voice client names for its own resampler', async () => {
    const clientSource = await readFile(
      join(process.cwd(), 'node_modules', '@elevenlabs', 'client', 'dist', 'platform', 'web', 'addLibsamplerateModule.js'),
      'utf8',
    )
    const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as { dependencies: Record<string, string> }

    const clientVersion = /@alexanderolsen\/libsamplerate-js@([0-9][^/"']*)\//.exec(clientSource)?.[1]

    expect(clientVersion).toBeDefined()
    expect(packageJson.dependencies['@alexanderolsen/libsamplerate-js']).toBe(clientVersion)
  })
})
