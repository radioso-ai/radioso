import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig, type Plugin } from 'vitest/config'

const rootDir = fileURLToPath(new URL('.', import.meta.url))

// Mirrors the `asset/source` webpack rule in next.config.mjs: markdown imports
// (settings docs) resolve to their raw content as a string default export.
const markdownAsSource: Plugin = {
  name: 'markdown-as-source',
  enforce: 'pre',
  load(id) {
    const [file] = id.split('?')
    if (file.endsWith('.md')) {
      return `export default ${JSON.stringify(readFileSync(file, 'utf8'))}`
    }
  },
}

export default defineConfig({
  root: rootDir,
  plugins: [markdownAsSource],
  resolve: {
    alias: [{ find: '@', replacement: path.resolve(rootDir, '.') }],
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
    globals: true,
  },
})
