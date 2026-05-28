'use client'

import { Fragment, type CSSProperties, type ReactNode, useState } from 'react'
import { ExternalLink, FileText } from 'lucide-react'

const URL_REGEX = /https?:\/\/[^\s<>)"']+/g

export function linkifyText(text: string): ReactNode[] {
  const parts: ReactNode[] = []
  let lastIndex = 0

  for (const match of text.matchAll(URL_REGEX)) {
    const url = match[0]
    const index = match.index
    if (index > lastIndex) {
      parts.push(text.slice(lastIndex, index))
    }
    parts.push(
      <a
        key={index}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--message-link-fg,var(--color-primary))] underline underline-offset-4 hover:text-[var(--message-link-hover-fg,var(--color-primary))]"
      >
        {url}
      </a>,
    )
    lastIndex = index + url.length
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  return parts.length > 0 ? parts : [text]
}

import { type AnswerSegment, type Citation } from '@/lib/api'
import { type WebsiteEmbedTheme } from '@/lib/embed-widget'
import { AssistantMarkdownContent } from './chat-markdown'

export type CitationOpenResult = 'opened' | 'unavailable' | 'error'

interface AssistantMessageContentProps {
  content: string
  citations?: Citation[]
  answerSegments?: AnswerSegment[]
  onOpenDocument: (documentId: string) => Promise<CitationOpenResult>
  theme?: WebsiteEmbedTheme | null
  isStreaming?: boolean
  showCitations?: boolean
}

const HTML_ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' ',
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
  '&laquo;': '«',
  '&raquo;': '»',
  '&lsquo;': '‘',
  '&rsquo;': '’',
  '&ldquo;': '“',
  '&rdquo;': '”',
}

const MAX_CODE_POINT = 0x10ffff

const decodeNumericEntity = (raw: string, code: number): string => {
  if (!Number.isInteger(code) || code < 0 || code > MAX_CODE_POINT) {
    return raw
  }
  try {
    return String.fromCodePoint(code)
  } catch {
    return raw
  }
}

const decodeHtmlEntities = (text: string) =>
  text
    .replace(/&[a-zA-Z]+;/g, (entity) => HTML_ENTITY_MAP[entity] ?? entity)
    .replace(/&#(\d+);/g, (raw, code: string) => decodeNumericEntity(raw, Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (raw, hex: string) => decodeNumericEntity(raw, parseInt(hex, 16)))

const getCitationLabel = (citation: Citation, index: number) =>
  decodeHtmlEntities(citation.title?.trim() || `Document ${index + 1}`)

const CitationMarker = ({
  citation,
  index,
  onOpenDocument,
}: {
  citation: Citation
  index: number
  onOpenDocument: (citation: Citation, index: number) => void
}) => (
  <button
    type="button"
    onClick={(event) => {
      event.stopPropagation()
      void onOpenDocument(citation, index)
    }}
    className="ml-0.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-primary/10 px-1 align-super text-[0.65em] font-semibold leading-none text-primary hover:bg-primary/20 focus-visible:bg-primary/20 focus-visible:outline-none"
    aria-label={`Open source ${index + 1}: ${getCitationLabel(citation, index)}`}
    data-citation-index={index + 1}
  >
    {index + 1}
  </button>
)

const SourceChip = ({
  citation,
  index,
  onOpenDocument,
}: {
  citation: Citation
  index: number
  onOpenDocument: (citation: Citation, index: number) => void
}) => {
  const label = getCitationLabel(citation, index)
  const sourceUrl = citation.sourceUrl?.trim()

  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-card px-2 py-0.5 text-xs leading-5">
      <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary/10 px-1 text-[10px] font-semibold leading-none text-primary">
        {index + 1}
      </span>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          void onOpenDocument(citation, index)
        }}
        className="inline-flex max-w-full items-center gap-1 truncate text-left text-muted-foreground hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline focus-visible:outline-none"
        title={label}
      >
        <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </button>
      {sourceUrl ? (
        <a
          href={sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => event.stopPropagation()}
          className="inline-flex shrink-0 items-center text-primary hover:text-primary/80"
          aria-label={`Open ${label} in a new tab`}
          title={sourceUrl}
        >
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      ) : null}
    </span>
  )
}

const getRenderableSegments = (
  content: string,
  answerSegments?: AnswerSegment[],
) => {
  if (answerSegments && answerSegments.length > 0) {
    return answerSegments
  }

  return [{ text: content }]
}

const hasBlockMarkdown = (content: string) => {
  const trimmed = content.trimEnd()
  return /\n\s*\n/.test(trimmed)
    || /^\s{0,3}([-+*]|\d+\.)\s+/m.test(trimmed)
    || /^\s{0,3}>/m.test(trimmed)
    || /^\s{0,3}#{1,6}\s+/m.test(trimmed)
    || /```/.test(trimmed)
    || /^\s*\|.+\|\s*$/m.test(trimmed)
}

const ORDERED_LIST_ITEM_PATTERN = /^(\s*)(\d+)\.\s+([\s\S]+)$/

const WORD_CHAR_PATTERN = /[\p{L}\p{N}]/u

// Only sentence punctuation may be pulled back onto a cited segment. Markdown-significant
// leading characters (*, _, ~, `, [, (, #, >, -, +) must never be absorbed, or the next
// segment's formatting would be stripped and rendered after the citation marker.
const SENTENCE_PUNCTUATION_ONLY_PATTERN = /^[\s.,;:!?…)\]}»”’"']+$/u
const LEADING_SENTENCE_PUNCTUATION_PATTERN = /^(\s*)([.,;:!?…)\]}»”’"']+)/u

const isPunctuationOnly = (text: string) => !WORD_CHAR_PATTERN.test(text)
const isSentencePunctuationOnly = (text: string) => SENTENCE_PUNCTUATION_ONLY_PATTERN.test(text)

const stripWhitespace = (text: string) => text.replace(/\s+/g, '')

type RenderableSegment = AnswerSegment & { trailingText?: string }

const redistributeLeadingPunctuation = (
  segments: AnswerSegment[],
  citations: Citation[],
): RenderableSegment[] => {
  const cloned: RenderableSegment[] = segments.map((segment) => ({ ...segment }))

  for (let index = 0; index < cloned.length; index += 1) {
    const current = cloned[index]
    if (getSegmentCitationIndices(current, citations).length === 0) {
      continue
    }

    let cursor = index + 1
    while (cursor < cloned.length) {
      const next = cloned[cursor]
      const nextHasCitations = getSegmentCitationIndices(next, citations).length > 0

      if (isSentencePunctuationOnly(next.text) && !nextHasCitations) {
        const punct = stripWhitespace(next.text)
        if (punct) {
          current.trailingText = (current.trailingText ?? '') + punct
        }
        next.text = ''
        cursor += 1
        continue
      }

      const leadingMatch = next.text.match(LEADING_SENTENCE_PUNCTUATION_PATTERN)
      if (leadingMatch) {
        const leadingWhitespace = leadingMatch[1]
        const leadingPunct = leadingMatch[2]
        current.trailingText = (current.trailingText ?? '') + leadingPunct
        next.text = leadingWhitespace + next.text.slice(leadingMatch[0].length)
      }
      break
    }
  }

  return cloned.filter((segment) => segment.text.length > 0)
}

const getSegmentCitationIndices = (segment: AnswerSegment, citations: Citation[]) =>
  [...new Set(segment.citationIndices ?? [])].filter(
    (index) => index >= 0 && index < citations.length,
  )

const getOrderedListItem = (segment: AnswerSegment) => {
  const match = segment.text.match(ORDERED_LIST_ITEM_PATTERN)
  if (!match) {
    return null
  }

  return {
    number: Number(match[2]),
    content: match[3],
  }
}

const collectUniqueCitations = (citations: Citation[]) => {
  const seen = new Set<string>()
  const unique: Array<{ citation: Citation; index: number }> = []

  for (let index = 0; index < citations.length; index += 1) {
    const citation = citations[index]
    if (!citation) {
      continue
    }
    const key = citation.documentId || `${citation.chunkId}-${index}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    unique.push({ citation, index })
  }

  return unique
}

export function AssistantMessageContent({
  content,
  citations = [],
  answerSegments,
  onOpenDocument,
  theme,
  isStreaming = false,
  showCitations = true,
}: AssistantMessageContentProps) {
  const [citationNotice, setCitationNotice] = useState<{ scope: string; message: string } | null>(null)
  const effectiveCitations = showCitations ? citations : []
  const effectiveAnswerSegments = showCitations ? answerSegments : undefined
  const noticeScope = `${content}|${effectiveCitations.length}|${effectiveAnswerSegments?.length ?? 0}`
  const rawSegments = getRenderableSegments(content, effectiveAnswerSegments)
  const segments = redistributeLeadingPunctuation(rawSegments, effectiveCitations)
  const contentThemeVars = theme
    ? ({
        '--message-link-fg': theme.accent,
        '--message-link-hover-fg': theme.accent,
      } as CSSProperties)
    : undefined

  const handleCitationOpen = async (citation: Citation, index: number) => {
    try {
      const result = await onOpenDocument(citation.documentId)
      if (result === 'opened') {
        setCitationNotice(null)
        return
      }

      if (result === 'unavailable') {
        setCitationNotice({
          scope: noticeScope,
          message: `${getCitationLabel(citation, index)} is unavailable because the source was deleted.`,
        })
        return
      }

      setCitationNotice({
        scope: noticeScope,
        message: `Unable to open ${getCitationLabel(citation, index)} right now.`,
      })
    } catch {
      setCitationNotice({
        scope: noticeScope,
        message: `Unable to open ${getCitationLabel(citation, index)} right now.`,
      })
    }
  }

  const renderCitations = (citationIndices: number[]) =>
    citationIndices.map((citationIndex) => {
      const citation = effectiveCitations[citationIndex]
      if (!citation) {
        return null
      }

      return (
        <Fragment key={`${citation.documentId}-${citation.chunkId}-${citationIndex}`}>
          <CitationMarker
            citation={citation}
            index={citationIndex}
            onOpenDocument={handleCitationOpen}
          />
        </Fragment>
      )
    })

  const contentNodes: ReactNode[] = []

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex]
    const orderedListItem = getOrderedListItem(segment)

    if (orderedListItem) {
      const listItems: Array<{
        key: string
        number: number
        content: string
        citationIndices: number[]
      }> = []

      for (let listIndex = segmentIndex; listIndex < segments.length; listIndex += 1) {
        const listSegment = segments[listIndex]
        const listItem = getOrderedListItem(listSegment)
        if (!listItem) {
          break
        }

        listItems.push({
          key: `segment-${listIndex}`,
          number: listItem.number,
          content: listItem.content,
          citationIndices: getSegmentCitationIndices(listSegment, effectiveCitations),
        })
        segmentIndex = listIndex
      }

      contentNodes.push(
        <ol key={`ordered-list-${segmentIndex}`} className="ml-5 list-decimal space-y-1 text-foreground">
          {listItems.map((item) => (
            <li key={item.key} value={item.number} className="ml-1 text-foreground">
              <AssistantMarkdownContent content={item.content} inline={!hasBlockMarkdown(item.content)} />
              {renderCitations(item.citationIndices)}
            </li>
          ))}
        </ol>,
      )
      continue
    }

    const dedupedIndices = getSegmentCitationIndices(segment, effectiveCitations)
    const segmentIsPunctuationOnly = isPunctuationOnly(segment.text)
    const inline =
      (dedupedIndices.length > 0 || segmentIsPunctuationOnly) && !hasBlockMarkdown(segment.text)

    contentNodes.push(
      <Fragment key={`segment-${segmentIndex}`}>
        <AssistantMarkdownContent content={segment.text} inline={inline} />
        {renderCitations(dedupedIndices)}
        {segment.trailingText ?? ''}
      </Fragment>,
    )
  }

  const uniqueCitations = collectUniqueCitations(effectiveCitations)

  return (
    <div className="space-y-2" style={contentThemeVars}>
      <div
        className={
          isStreaming
            ? 'radioso-streaming-content text-sm break-words leading-6'
            : 'text-sm break-words leading-6'
        }
      >
        {contentNodes}
      </div>
      {uniqueCitations.length > 0 ? (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5 pt-1 text-xs text-muted-foreground">
          <span className="font-semibold uppercase tracking-[0.08em]">Sources</span>
          {uniqueCitations.map(({ citation, index }) => (
            <SourceChip
              key={`source-${citation.documentId}-${index}`}
              citation={citation}
              index={index}
              onOpenDocument={handleCitationOpen}
            />
          ))}
        </div>
      ) : null}
      {citationNotice && citationNotice.scope === noticeScope ? (
        <p className="text-xs text-amber-300" role="status">
          {citationNotice.message}
        </p>
      ) : null}
    </div>
  )
}
