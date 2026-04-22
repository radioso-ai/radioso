import { copyFile, mkdir, access } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const docsRoot = process.cwd()
const repoRoot = path.resolve(docsRoot, '..')
const source = path.join(repoRoot, 'backend', 'openapi.json')
const targetDir = path.join(docsRoot, 'public')
const target = path.join(targetDir, 'openapi.json')

try {
  await access(source)
} catch {
  console.error(
    [
      'Missing backend/openapi.json.',
      'Generate it first with:',
      '  cd backend && npm run generate:openapi',
    ].join('\n')
  )
  process.exit(1)
}

await mkdir(targetDir, { recursive: true })
await copyFile(source, target)
console.log(`Copied OpenAPI spec to ${path.relative(docsRoot, target)}`)
