'use client'

import { type ReactNode } from 'react'

import { MarkdownContent } from '@/components/markdown/markdown-content'

const UNORDERED_LIST_MARKER_PATTERN = /(^|\s)([-+*•])\s+/g
const BLOCK_UNORDERED_LIST_MARKER_PATTERN = /^\s{0,3}[-+*•]\s+/
// Markdown inline links whose visible label may itself contain " - " (e.g. course
// titles like "ARYTT - Raja Yoga Teaching 3 - How to be a Spiritual Teacher"). Those
// hyphens are part of the link text, not inline list markers — splitting on them
// injects a bullet list inside the link and shatters it.
const MARKDOWN_LINK_PATTERN = /\[[^\]]*\]\([^)]*\)/g

const INLINE_LIST_ITEM_LETTER_PATTERN = /[\p{L}]/u

const findLinkSpans = (line: string): Array<[number, number]> =>
  Array.from(line.matchAll(MARKDOWN_LINK_PATTERN)).map((match) => {
    const start = match.index ?? 0
    return [start, start + match[0].length]
  })

const isInsideSpan = (index: number, spans: Array<[number, number]>) =>
  spans.some(([start, end]) => index >= start && index < end)

const looksLikeInlineListItems = (items: string[]) =>
  items.length >= 2 &&
  items.every((item) => INLINE_LIST_ITEM_LETTER_PATTERN.test(item)) &&
  items.filter((item) => item.trim().split(/\s+/).length >= 2).length >= 2

const expandInlineUnorderedLists = (content: string) =>
  content
    .split('\n')
    .map((line) => {
      if (BLOCK_UNORDERED_LIST_MARKER_PATTERN.test(line)) {
        return line
      }

      const linkSpans = findLinkSpans(line)
      const matches = Array.from(line.matchAll(UNORDERED_LIST_MARKER_PATTERN)).filter(
        (match) => !isInsideSpan(match.index ?? 0, linkSpans),
      )
      if (matches.length < 2) {
        return line
      }

      const prefix = line.slice(0, matches[0]?.index ?? 0).trimEnd()
      const items = matches
        .map((match, index) => {
          const itemStart = (match.index ?? 0) + match[0].length
          const nextMatch = matches[index + 1]
          const itemEnd = nextMatch?.index ?? line.length
          return line.slice(itemStart, itemEnd).trim()
        })
        .filter((item) => item.length > 0)

      if (!looksLikeInlineListItems(items)) {
        return line
      }

      return [prefix, ...items.map((item) => `- ${item}`)].filter((part) => part.length > 0).join('\n')
    })
    .join('\n')

export function AssistantMarkdownContent({
  content,
  inline = false,
  trailingInlineContent,
  onLinkClick,
  transformLinkHref,
}: {
  content: string
  inline?: boolean
  trailingInlineContent?: ReactNode
  onLinkClick?: (href: string) => void
  transformLinkHref?: (href: string) => string
}) {
  const normalizedContent = expandInlineUnorderedLists(content)

  return (
    <MarkdownContent
      content={normalizedContent}
      variant="chat"
      inline={inline}
      trailingInlineContent={trailingInlineContent}
      onLinkClick={onLinkClick}
      transformLinkHref={transformLinkHref}
    />
  )
}
