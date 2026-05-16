import { copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { createRequire } from 'node:module'

const docsRoot = process.cwd()
const require = createRequire(import.meta.url)

const mainPath = require.resolve('@stoplight/elements')
const pkgDir = path.dirname(mainPath)

const targetDir = path.join(docsRoot, 'public', 'vendor', 'stoplight')
await mkdir(targetDir, { recursive: true })

const assets = ['web-components.min.js', 'styles.min.css']
for (const asset of assets) {
  await copyFile(path.join(pkgDir, asset), path.join(targetDir, asset))
}

console.log(`Copied Stoplight Elements assets to ${path.relative(docsRoot, targetDir)}`)
