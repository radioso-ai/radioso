import type { MetadataRoute } from 'next'
import { readdir } from 'node:fs/promises'
import path from 'node:path'

import { absoluteUrl } from '@/lib/site'

// The sitemap is derived from the MDX tree so it cannot drift from the content
// directory. `contentDirBasePath: '/'` in next.config.mjs means a file's path
// under content/ is its route, with `index.mdx` collapsing to its directory.
const CONTENT_DIR = path.join(process.cwd(), 'content')

async function collectRoutes(dir: string, prefix: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const routes: string[] = []

  for (const entry of entries) {
    if (entry.isDirectory()) {
      routes.push(...(await collectRoutes(path.join(dir, entry.name), `${prefix}/${entry.name}`)))
      continue
    }
    if (!entry.name.endsWith('.mdx')) continue
    const slug = entry.name.replace(/\.mdx$/, '')
    routes.push(slug === 'index' ? prefix || '/' : `${prefix}/${slug}`)
  }

  return routes
}

export const dynamic = 'force-static'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const routes = await collectRoutes(CONTENT_DIR, '')

  // Not MDX-backed: the Stoplight-rendered OpenAPI browser.
  routes.push('/api-reference')

  return [...new Set(routes)].sort().map((route) => ({
    url: absoluteUrl(route),
    changeFrequency: 'weekly' as const,
    priority: route === '/' ? 1 : 0.7,
  }))
}
