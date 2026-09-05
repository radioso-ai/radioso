'use client'

import { usePathname } from 'next/navigation'
import { normalizePages } from 'nextra/normalize-pages'
import { createContext, useContext, useMemo, type ReactNode } from 'react'

/**
 * The docs navigation is derived from Nextra's page map, which Nextra builds
 * from `content/**` plus the `_meta.js` convention files. Those files are the
 * single source of truth for ordering and titles; nothing here maintains a
 * parallel list that could drift from the pages that actually exist.
 */
export type DocsPageMap = Parameters<typeof normalizePages>[0]['list']

type NormalizedPages = ReturnType<typeof normalizePages>
type DocsDirectory = NormalizedPages['docsDirectories'][number]
type ActivePathItem = NormalizedPages['activePath'][number]

export type NavLink = {
  title: string
  href: string
  external: boolean
}

export type NavGroup = {
  key: string
  /** `null` for top-level pages that are not inside a section folder. */
  title: string | null
  items: NavLink[]
}

export type DocsNav = NormalizedPages & {
  groups: NavGroup[]
  breadcrumbs: NavLink[]
  previous: NavLink | null
  next: NavLink | null
}

const PageMapContext = createContext<DocsPageMap | null>(null)

export function DocsNavProvider({
  pageMap,
  children,
}: {
  pageMap: DocsPageMap
  children: ReactNode
}) {
  return <PageMapContext.Provider value={pageMap}>{children}</PageMapContext.Provider>
}

const EXTERNAL_RE = /^[a-z][a-z0-9+.-]*:|^\/\//i

function titleOf(item: { title?: ReactNode; name?: string }): string {
  if (typeof item.title === 'string') return item.title
  return item.name ?? ''
}

function hrefOf(item: DocsDirectory | ActivePathItem): string | undefined {
  if ('href' in item && typeof item.href === 'string') return item.href
  return 'route' in item ? item.route : undefined
}

function toLink(item: DocsDirectory | ActivePathItem): NavLink | null {
  const href = hrefOf(item)
  if (!href) return null
  return { title: titleOf(item), href, external: EXTERNAL_RE.test(href) }
}

function childrenOf(item: DocsDirectory): DocsDirectory[] | undefined {
  return 'children' in item && Array.isArray(item.children) && item.children.length > 0
    ? (item.children)
    : undefined
}

function isSeparator(item: DocsDirectory): boolean {
  return 'type' in item && item.type === 'separator'
}

function collectLinks(items: DocsDirectory[], into: NavLink[]): void {
  for (const item of items) {
    if (isSeparator(item)) continue

    const children = childrenOf(item)
    if (children) {
      // Folders never link to themselves: their `index` page is already one of
      // the children and carries the section's own route.
      collectLinks(children, into)
      continue
    }

    const link = toLink(item)
    if (link) into.push(link)
  }
}

/**
 * Turns the normalized page map into the sidebar shape: folders become labelled
 * sections, and runs of top-level pages become unlabelled groups so the order
 * declared in `content/_meta.js` is preserved exactly.
 */
function buildGroups(docsDirectories: DocsDirectory[]): NavGroup[] {
  const groups: NavGroup[] = []
  let looseGroup: NavGroup | null = null

  for (const item of docsDirectories) {
    if (isSeparator(item)) {
      looseGroup = null
      continue
    }

    const children = childrenOf(item)
    if (children) {
      const items: NavLink[] = []
      collectLinks(children, items)
      if (items.length > 0) {
        groups.push({
          key: hrefOf(item) ?? titleOf(item),
          title: titleOf(item),
          items,
        })
      }
      looseGroup = null
      continue
    }

    const link = toLink(item)
    if (!link) continue

    if (!looseGroup) {
      looseGroup = { key: `pages-${groups.length}`, title: null, items: [] }
      groups.push(looseGroup)
    }
    looseGroup.items.push(link)
  }

  return groups
}

export function useDocsNav(): DocsNav | null {
  const pageMap = useContext(PageMapContext)
  const pathname = usePathname()

  return useMemo(() => {
    if (!pageMap || pageMap.length === 0) return null

    const route = pathname || '/'
    const normalized = normalizePages({ list: pageMap, route })
    const { activePath, flatDocsDirectories, activeIndex } = normalized

    const breadcrumbs = activePath
      .map(toLink)
      .filter((link): link is NavLink => link !== null)

    const activeLeaf = activePath.at(-1)
    const isActiveRoute = activeLeaf ? hrefOf(activeLeaf) === route : false
    const siblingAt = (index: number): NavLink | null => {
      if (!isActiveRoute) return null
      const sibling = flatDocsDirectories[index] as DocsDirectory | undefined
      return sibling ? toLink(sibling) : null
    }

    return {
      ...normalized,
      groups: buildGroups(normalized.docsDirectories),
      breadcrumbs,
      previous: siblingAt(activeIndex - 1),
      next: siblingAt(activeIndex + 1),
    }
  }, [pageMap, pathname])
}

/** Case-insensitive substring filter over nav titles, dropping empty groups. */
export function filterGroups(groups: NavGroup[], query: string): NavGroup[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return groups

  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) =>
          item.title.toLowerCase().includes(needle) ||
          (group.title?.toLowerCase().includes(needle) ?? false),
      ),
    }))
    .filter((group) => group.items.length > 0)
}
