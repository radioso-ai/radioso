'use client'

import { type ReactNode } from 'react'

import { MarkdownContent } from '@/components/markdown/markdown-content'

const UNORDERED_LIST_MARKER_PATTERN = /(^|\s)([-+*•])\s+/g
const BLOCK_UNORDERED_LIST_MARKER_PATTERN = /^\s{0,3}[-+*•]\s+/
// Ordered-list item lines ("1. …", "2) …") must NOT be re-split by the inline-bullet
// expansion below: a " - " inside an item's text is prose, not a bullet marker.
// Splitting it shatters the ordered list — each numbered item becomes its own <ol>,
// so every point renders as "1.".
const BLOCK_ORDERED_LIST_MARKER_PATTERN = /^\s{0,3}\d+[.)]\s+/
// A bullet marker at the very start of a line (no leading indent).
const FLUSH_UNORDERED_LIST_MARKER_PATTERN = /^[-+*•]\s+/
const ORDERED_SUB_BULLET_INDENT = '   '
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
      if (BLOCK_UNORDERED_LIST_MARKER_PATTERN.test(line) || BLOCK_ORDERED_LIST_MARKER_PATTERN.test(line)) {
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

// LLMs frequently write a numbered list where every item is "1." and each item's
// sub-points are flush-left bullets. CommonMark ends the ordered list at each bullet
// block, so the next "1." starts a fresh list and every item renders as "1.". Re-indent
// those flush-left bullets so they nest under the current ordered item, keeping a single
// ordered list that numbers 1, 2, 3. Already-indented bullets and blank-line/paragraph
// breaks are left alone, so genuinely separate lists are unaffected.
const nestFlushBulletsUnderOrderedItems = (content: string): string => {
  let inOrderedItem = false
  return content
    .split('\n')
    .map((line) => {
      if (BLOCK_ORDERED_LIST_MARKER_PATTERN.test(line)) {
        inOrderedItem = true
        return line
      }
      if (inOrderedItem && FLUSH_UNORDERED_LIST_MARKER_PATTERN.test(line)) {
        return `${ORDERED_SUB_BULLET_INDENT}${line}`
      }
      if (line.trim() === '') {
        // A blank line keeps the loose-list context so blank-separated sub-bullets
        // still nest; only real paragraph content ends the ordered list.
        return line
      }
      inOrderedItem = false
      return line
    })
    .join('\n')
}

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
  const normalizedContent = expandInlineUnorderedLists(nestFlushBulletsUnderOrderedItems(content))

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
