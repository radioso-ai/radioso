'use client'

import { Fragment, type ComponentPropsWithoutRef } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { cn } from '@/lib/utils'

const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

const isSafeHref = (href?: string) => {
  if (!href) {
    return false
  }

  if (href.startsWith('/') || href.startsWith('#')) {
    return true
  }

  try {
    const url = new URL(href)
    return SAFE_LINK_PROTOCOLS.has(url.protocol)
  } catch {
    return false
  }
}

const UNORDERED_LIST_MARKER_PATTERN = /(^|\s)([-+*•])\s+/g

const INLINE_LIST_ITEM_LETTER_PATTERN = /[\p{L}]/u

const looksLikeInlineListItems = (items: string[]) =>
  items.length >= 2 &&
  items.every((item) => INLINE_LIST_ITEM_LETTER_PATTERN.test(item)) &&
  items.filter((item) => item.trim().split(/\s+/).length >= 2).length >= 2

const expandInlineUnorderedLists = (content: string) =>
  content
    .split('\n')
    .map((line) => {
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

const MarkdownLink = ({
  href,
  children,
  className,
}: ComponentPropsWithoutRef<'a'>) => {
  if (!isSafeHref(href)) {
    return <span className="text-foreground">{children}</span>
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'text-[var(--message-link-fg,var(--color-primary))] underline underline-offset-4 hover:text-[var(--message-link-hover-fg,var(--color-primary))]',
        className,
      )}
    >
      {children}
    </a>
  )
}

const createMarkdownComponents = (inline: boolean): Components => ({
  a: MarkdownLink,
  blockquote: ({ children, className }) => (
    <blockquote
      className={cn('border-l-2 border-border pl-4 italic text-muted-foreground', className)}
    >
      {children}
    </blockquote>
  ),
  code: ({ children, className }) => (
    <code className={cn('rounded bg-muted px-1 py-0.5 font-mono text-[0.95em]', className)}>
      {children}
    </code>
  ),
  em: ({ children, className }) => (
    <em className={cn('italic', className)}>
      {children}
    </em>
  ),
  h1: ({ children, className }) => (
    <p className={cn('m-0 text-base font-semibold', className)}>
      {children}
    </p>
  ),
  h2: ({ children, className }) => (
    <p className={cn('m-0 text-base font-semibold', className)}>
      {children}
    </p>
  ),
  h3: ({ children, className }) => (
    <p className={cn('m-0 text-sm font-semibold', className)}>
      {children}
    </p>
  ),
  h4: ({ children, className }) => (
    <p className={cn('m-0 text-sm font-semibold', className)}>
      {children}
    </p>
  ),
  h5: ({ children, className }) => (
    <p className={cn('m-0 text-sm font-medium', className)}>
      {children}
    </p>
  ),
  h6: ({ children, className }) => (
    <p className={cn('m-0 text-sm font-medium', className)}>
      {children}
    </p>
  ),
  img: () => null,
  li: ({ children, className }) => (
    <li className={cn('ml-1 text-foreground', className)}>
      {children}
    </li>
  ),
  ol: ({ children, className }) => (
    <ol className={cn('ml-5 list-decimal space-y-1 text-foreground', className)}>
      {children}
    </ol>
  ),
  p: ({ children, className }) => (
    inline ? (
      <Fragment>{children}</Fragment>
    ) : (
      <p className={cn('m-0 text-foreground', className)}>
        {children}
      </p>
    )
  ),
  pre: ({ children, className }) => (
    <pre
      className={cn(
        'overflow-x-auto rounded-md border border-border bg-muted px-4 py-3 text-xs leading-6 text-foreground [&_code]:bg-transparent [&_code]:px-0 [&_code]:py-0 [&_code]:text-inherit',
        className,
      )}
    >
      {children}
    </pre>
  ),
  strong: ({ children, className }) => (
    <strong className={cn('font-semibold text-foreground', className)}>
      {children}
    </strong>
  ),
  ul: ({ children, className }) => (
    <ul className={cn('ml-5 list-disc space-y-1 text-foreground', className)}>
      {children}
    </ul>
  ),
})

export function AssistantMarkdownContent({
  content,
  inline = false,
}: {
  content: string
  inline?: boolean
}) {
  const normalizedContent = expandInlineUnorderedLists(content)

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={createMarkdownComponents(inline)}
    >
      {normalizedContent}
    </ReactMarkdown>
  )
}
