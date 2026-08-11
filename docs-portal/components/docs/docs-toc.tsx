'use client'

import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'

import { cn } from '@radioso/ui/utils'

export type TocHeading = {
  id: string
  depth: number
  title: string
}

const INDENT_BY_DEPTH: Record<number, string> = {
  2: 'ps-3',
  3: 'ps-6',
  4: 'ps-9',
}

/**
 * Reads the headings out of the rendered page. Nextra only hands its `toc`
 * export to the MDX `wrapper`, which this project's routing never invokes, so
 * the rendered document is the reliable source for the on-page contents.
 */
function useRenderedHeadings(contentId: string): TocHeading[] {
  const pathname = usePathname()
  const [headings, setHeadings] = useState<TocHeading[]>([])

  useEffect(() => {
    // Read after paint rather than in the effect body: the document is an
    // external system here, and the read must see the committed route content.
    const frame = requestAnimationFrame(() => {
      const root = document.getElementById(contentId)
      const nodes = root
        ? Array.from(root.querySelectorAll<HTMLElement>('h2[id], h3[id], h4[id]'))
        : []

      setHeadings(
        nodes.map((node) => ({
          id: node.id,
          depth: Number(node.tagName.slice(1)),
          title: (node.textContent ?? '').trim(),
        })),
      )
    })

    return () => cancelAnimationFrame(frame)
  }, [contentId, pathname])

  return headings
}

/**
 * Scroll-spy over the rendered headings. Uses a viewport band near the top of
 * the page so the highlighted entry matches what the reader is looking at.
 */
function useActiveHeading(idList: string): string {
  const [activeId, setActiveId] = useState('')

  useEffect(() => {
    const ids = idList ? idList.split('\n') : []
    if (ids.length === 0) return

    const elements = ids
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement => element !== null)

    if (elements.length === 0) return

    const visible = new Set<string>()

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id)
          else visible.delete(entry.target.id)
        }

        const firstVisible = ids.find((id) => visible.has(id))
        if (firstVisible) {
          setActiveId(firstVisible)
          return
        }

        // Nothing inside the band: fall back to the last heading scrolled past.
        const scrolled = elements.filter((element) => element.getBoundingClientRect().top < 120)
        setActiveId(scrolled.at(-1)?.id ?? '')
      },
      { rootMargin: '-80px 0px -70% 0px', threshold: 0 },
    )

    for (const element of elements) observer.observe(element)

    return () => observer.disconnect()
  }, [idList])

  return activeId
}

export function DocsToc({ contentId }: { contentId: string }) {
  const headings = useRenderedHeadings(contentId)
  const activeId = useActiveHeading(headings.map((heading) => heading.id).join('\n'))

  if (headings.length === 0) return null

  return (
    <nav
      aria-labelledby="docs-toc-heading"
      className="order-last hidden w-56 shrink-0 xl:block print:hidden"
    >
      <div className="sticky top-24 max-h-[calc(100vh-8rem)] overflow-y-auto pb-8">
        <p
          id="docs-toc-heading"
          className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
        >
          On this page
        </p>
        <ul className="space-y-1 border-s border-border/70">
          {headings.map((heading) => {
            const active = heading.id === activeId

            return (
              <li key={heading.id}>
                <a
                  href={`#${heading.id}`}
                  aria-current={active ? 'location' : undefined}
                  className={cn(
                    '-ms-px block border-s border-transparent py-1 pe-2 text-sm transition-colors',
                    INDENT_BY_DEPTH[heading.depth] ?? 'ps-3',
                    active
                      ? 'border-primary font-medium text-primary'
                      : 'text-muted-foreground hover:border-border hover:text-foreground',
                  )}
                >
                  {heading.title}
                </a>
              </li>
            )
          })}
        </ul>
      </div>
    </nav>
  )
}
