import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { absoluteUrl } from '@/lib/site'

const CONTENT_DIR = path.join(process.cwd(), 'content')

type ContentPage = {
  description: string
  route: string
  title: string
}

const frontmatterValue = (source: string, key: string): string => {
  const prefix = `${key}: `
  const line = source.split('\n').find((candidate) => candidate.startsWith(prefix))
  if (!line) return ''
  const value = line.slice(prefix.length).trim()
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
}

const routeFor = (prefix: string, fileName: string): string => {
  const slug = fileName.replace(/\.mdx$/u, '')
  return slug === 'index' ? prefix || '/' : `${prefix}/${slug}`
}

async function collectContentPages(dir: string, prefix: string): Promise<ContentPage[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const pages: ContentPage[] = []

  for (const entry of entries) {
    if (entry.isDirectory()) {
      pages.push(...(await collectContentPages(path.join(dir, entry.name), `${prefix}/${entry.name}`)))
      continue
    }
    if (!entry.name.endsWith('.mdx')) continue

    const source = await readFile(path.join(dir, entry.name), 'utf8')
    pages.push({
      description: frontmatterValue(source, 'description'),
      route: routeFor(prefix, entry.name),
      title: frontmatterValue(source, 'title'),
    })
  }

  return pages
}

/** Documentation metadata derived from the MDX tree for build-time machine readers. */
const listContentPages = async (): Promise<ContentPage[]> =>
  (await collectContentPages(CONTENT_DIR, '')).sort((left, right) => left.route.localeCompare(right.route))

export const renderLlmsTxt = async (): Promise<string> => {
  const pages = await listContentPages()
  const entries = pages.map(({ description, route, title }) =>
    `- [${title}](${absoluteUrl(route)}): ${description}`)

  return [
    '# Radioso Docs',
    '',
    '> Documentation for building, operating, and connecting conversational agents with Radioso.',
    '',
    '## Pages',
    '',
    ...entries,
    '',
  ].join('\n')
}
