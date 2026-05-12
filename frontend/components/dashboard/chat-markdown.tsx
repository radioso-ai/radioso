'use client'

import { MarkdownContent } from '@/components/markdown/markdown-content'

const UNORDERED_LIST_MARKER_PATTERN = /(^|\s)([-+*•])\s+/g
const BLOCK_UNORDERED_LIST_MARKER_PATTERN = /^\s{0,3}[-+*•]\s+/

const INLINE_LIST_ITEM_LETTER_PATTERN = /[\p{L}]/u

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

      const matches = Array.from(line.matchAll(UNORDERED_LIST_MARKER_PATTERN))
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
}: {
  content: string
  inline?: boolean
}) {
  const normalizedContent = expandInlineUnorderedLists(content)

  return <MarkdownContent content={normalizedContent} variant="chat" inline={inline} />
}
