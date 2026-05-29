'use client'

import { Fragment, useMemo, type ComponentPropsWithoutRef } from 'react'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { cn } from '@/lib/utils'

import { CodeBlock } from './code-block'

const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

type HastElement = NonNullable<ExtraProps['node']>
type ElementContent = HastElement['children'][number]

export const isSafeHref = (href?: string) => {
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

const SAFE_IMAGE_PROTOCOLS = new Set(['http:', 'https:'])

const isSafeImageSrc = (src?: string) => {
  if (!src) {
    return false
  }
  if (src.startsWith('/')) {
    return true
  }
  try {
    const url = new URL(src)
    return SAFE_IMAGE_PROTOCOLS.has(url.protocol)
  } catch {
    return false
  }
}

const collectText = (nodes: readonly ElementContent[]): string =>
  nodes
    .map((node) => {
      if (node.type === 'text') {
        return node.value
      }
      if (node.type === 'element') {
        return collectText(node.children)
      }
      return ''
    })
    .join('')

const extractFencedCode = (node?: HastElement): { code: string; language?: string } | null => {
  const codeElement = node?.children.find(
    (child): child is HastElement => child.type === 'element' && child.tagName === 'code',
  )
  if (!codeElement) {
    return null
  }
  const classes = codeElement.properties?.className
  const classList = Array.isArray(classes)
    ? classes.map((value) => String(value))
    : typeof classes === 'string'
      ? [classes]
      : []
  const languageClass = classList.find((value) => value.startsWith('language-'))
  const language = languageClass ? languageClass.slice('language-'.length) : undefined
  const code = collectText(codeElement.children).replace(/\n$/, '')
  return { code, language }
}

const MarkdownLink = ({
  href,
  children,
  className,
  onLinkClick,
  transformLinkHref,
}: ComponentPropsWithoutRef<'a'> & {
  onLinkClick?: (href: string) => void
  transformLinkHref?: (href: string) => string
}) => {
  if (!isSafeHref(href)) {
    return <span className="text-foreground">{children}</span>
  }

  const outboundHref = transformLinkHref?.(href) ?? href
  if (!isSafeHref(outboundHref)) {
    return <span className="text-foreground">{children}</span>
  }

  return (
    <a
      href={outboundHref}
      target="_blank"
      rel="noopener"
      onClick={() => {
        onLinkClick?.(outboundHref)
      }}
      className={cn(
        'text-[var(--message-link-fg,var(--color-primary))] underline underline-offset-4 hover:text-[var(--message-link-hover-fg,var(--color-primary))]',
        className,
      )}
    >
      {children}
    </a>
  )
}

export type MarkdownVariant = 'chat' | 'document'

type PreProps = ComponentPropsWithoutRef<'pre'> & ExtraProps

const chatHeadingClasses: Record<1 | 2 | 3 | 4 | 5 | 6, string> = {
  1: 'mt-2 mb-1 text-base font-semibold text-foreground',
  2: 'mt-2 mb-1 text-base font-semibold text-foreground',
  3: 'mt-2 mb-1 text-sm font-semibold text-foreground',
  4: 'mt-1 mb-1 text-sm font-semibold text-foreground',
  5: 'mt-1 mb-1 text-sm font-medium text-foreground',
  6: 'mt-1 mb-1 text-sm font-medium text-foreground',
}

const documentHeadingClasses: Record<1 | 2 | 3 | 4 | 5 | 6, string> = {
  1: 'mt-6 mb-3 text-2xl font-semibold text-foreground',
  2: 'mt-6 mb-3 text-xl font-semibold text-foreground',
  3: 'mt-5 mb-2 text-lg font-semibold text-foreground',
  4: 'mt-4 mb-2 text-base font-semibold text-foreground',
  5: 'mt-4 mb-2 text-sm font-semibold text-foreground',
  6: 'mt-4 mb-2 text-sm font-medium text-muted-foreground',
}

const buildHeading = (
  level: 1 | 2 | 3 | 4 | 5 | 6,
  classes: Record<1 | 2 | 3 | 4 | 5 | 6, string>,
) => {
  const Tag = `h${level}` as 'h1'
  const Component = ({ children, className }: ComponentPropsWithoutRef<'h1'>) => (
    <Tag className={cn(classes[level], className)}>{children}</Tag>
  )
  Component.displayName = `MarkdownHeading${level}`
  return Component
}

const createComponents = (
  variant: MarkdownVariant,
  inline: boolean,
  onLinkClick?: (href: string) => void,
  transformLinkHref?: (href: string) => string,
): Components => {
  const headingClasses = variant === 'chat' ? chatHeadingClasses : documentHeadingClasses

  return {
    a: ({ href, children, className }) => (
      <MarkdownLink
        href={href}
        className={className}
        onLinkClick={onLinkClick}
        transformLinkHref={transformLinkHref}
      >
        {children}
      </MarkdownLink>
    ),
    blockquote: ({ children, className }) => (
      <blockquote
        className={cn(
          'my-2 border-l-2 border-border pl-4 italic text-muted-foreground',
          className,
        )}
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
      <em className={cn('italic', className)}>{children}</em>
    ),
    h1: buildHeading(1, headingClasses),
    h2: buildHeading(2, headingClasses),
    h3: buildHeading(3, headingClasses),
    h4: buildHeading(4, headingClasses),
    h5: buildHeading(5, headingClasses),
    h6: buildHeading(6, headingClasses),
    hr: ({ className }) => (
      <hr className={cn('my-4 border-border', className)} />
    ),
    img: ({ src, alt, title }) => {
      if (variant !== 'document') {
        return null
      }
      const href = typeof src === 'string' ? src : undefined
      if (!isSafeImageSrc(href)) {
        return alt ? <span className="text-muted-foreground">{alt}</span> : null
      }
      return (
        // eslint-disable-next-line @next/next/no-img-element -- markdown image URLs are arbitrary and not known at build time
        <img
          src={href}
          alt={alt ?? ''}
          title={title}
          loading="lazy"
          referrerPolicy="no-referrer"
          className="my-3 h-auto max-w-full rounded-md border border-border"
        />
      )
    },
    input: ({ type, checked, disabled, className, ...rest }) => {
      if (type === 'checkbox') {
        return (
          <input
            type="checkbox"
            checked={!!checked}
            disabled
            readOnly
            className={cn('mr-1.5 align-middle accent-[var(--color-primary)]', className)}
            {...rest}
          />
        )
      }
      return (
        <input
          type={type}
          disabled={disabled}
          className={className}
          {...rest}
        />
      )
    },
    li: ({ children, className }) => (
      <li className={cn('ml-1 text-foreground', className)}>{children}</li>
    ),
    ol: ({ children, className }) => (
      <ol className={cn('my-3 ml-5 list-decimal space-y-1.5 text-foreground first:mt-0', className)}>
        {children}
      </ol>
    ),
    p: ({ children, className }) =>
      inline ? (
        <Fragment>{children}</Fragment>
      ) : (
        <p className={cn('mt-3 text-foreground first:mt-0', className)}>{children}</p>
      ),
    pre: ({ children, node }: PreProps) => {
      const fenced = extractFencedCode(node)
      if (fenced) {
        return <CodeBlock code={fenced.code} language={fenced.language} />
      }
      return <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 text-xs leading-6 text-foreground">{children}</pre>
    },
    strong: ({ children, className }) => (
      <strong className={cn('font-semibold text-foreground', className)}>
        {children}
      </strong>
    ),
    table: ({ children, className }) => (
      <div className="my-3 w-full overflow-x-auto">
        <table
          className={cn(
            'w-full border-collapse text-left text-sm text-foreground',
            className,
          )}
        >
          {children}
        </table>
      </div>
    ),
    thead: ({ children, className }) => (
      <thead className={cn('bg-muted/40', className)}>{children}</thead>
    ),
    tbody: ({ children, className }) => (
      <tbody className={className}>{children}</tbody>
    ),
    tr: ({ children, className }) => (
      <tr className={cn('border-b border-border last:border-0', className)}>
        {children}
      </tr>
    ),
    th: ({ children, className }) => (
      <th
        className={cn(
          'border-b border-border px-3 py-2 text-left font-semibold',
          className,
        )}
      >
        {children}
      </th>
    ),
    td: ({ children, className }) => (
      <td className={cn('px-3 py-2 align-top', className)}>{children}</td>
    ),
    ul: ({ children, className }) => (
      <ul className={cn('my-3 ml-5 list-disc space-y-1.5 text-foreground first:mt-0', className)}>
        {children}
      </ul>
    ),
  }
}

// Memoizing keeps the `components` object identity stable across renders so
// react-markdown reconciles tags in place instead of unmounting them. Without
// this, every render replaced live DOM (e.g. a focused <a> inside an <li>),
// which dropped focus mid-click and prevented link clicks from completing.
const REMARK_PLUGINS = [remarkGfm]

export function MarkdownContent({
  content,
  variant = 'chat',
  inline = false,
  onLinkClick,
  transformLinkHref,
}: {
  content: string
  variant?: MarkdownVariant
  inline?: boolean
  onLinkClick?: (href: string) => void
  transformLinkHref?: (href: string) => string
}) {
  const components = useMemo(
    () => createComponents(variant, inline, onLinkClick, transformLinkHref),
    [variant, inline, onLinkClick, transformLinkHref],
  )
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
      {content}
    </ReactMarkdown>
  )
}
