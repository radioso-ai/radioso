'use client'

import { Fragment, type CSSProperties, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, ExternalLink, FileText } from 'lucide-react'

import { MESSAGE_LINK_CLASS, isSafeHref } from '../markdown/markdown-content'

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
    parts.push(isSafeHref(url)
      ? (
          <a
            key={index}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className={MESSAGE_LINK_CLASS}
          >
            {url}
          </a>
        )
      : <span key={index}>{url}</span>)
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
export type AssistantLinkClickType = 'citation_marker' | 'source_chip' | 'citation_source_url' | 'assistant_url'

export interface AssistantLinkClickAnalyticsInput {
  linkType: AssistantLinkClickType
  citationIndex?: number
  documentId?: string
  chunkId?: string
  destinationUrl?: string
}

interface AssistantMessageContentProps {
  content: string
  citations?: Citation[]
  answerSegments?: AnswerSegment[]
  onOpenDocument: (documentId: string) => Promise<CitationOpenResult>
  onLinkClickAnalytics?: (input: AssistantLinkClickAnalyticsInput) => void
  transformAssistantLinkHref?: (href: string) => string
  theme?: WebsiteEmbedTheme | null
  isStreaming?: boolean
  showCitations?: boolean
  // 'open' (default) lets a citation open the underlying document in the
  // dashboard viewer. 'link-only' is for public surfaces: sources are shown but
  // never openable — only an outbound source link (when present) is exposed.
  documentInteractivity?: 'open' | 'link-only'
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

// Sized to sit tight against the word it annotates: the pill's own padding is what
// reads as a space between the word, the marker and the punctuation that follows, so
// it stays just wide enough to keep a single digit circular.
const CITATION_MARKER_BASE_CLASS =
  'ml-px inline-flex h-3.5 min-w-[0.875rem] items-center justify-center rounded-full bg-primary/10 px-0.5 align-super text-[0.62em] font-semibold leading-none text-primary'

// A marker is an atomic inline box, and UAX#14 allows a line break on either
// side of one even with no whitespace there. So a marker — and the sentence
// punctuation the segment carries after it — can wrap away from the word it
// annotates, leaving the next line to open with a stray "2 .". U+2060 WORD
// JOINER suppresses the break between the preceding word and the cluster
// (UAX#14 LB11), and `whitespace-nowrap` suppresses the ones between the
// markers and their punctuation.
const CITATION_WORD_JOINER = '\u2060'

const CitationMarker = ({
  citation,
  index,
  interactive,
  onOpenDocument,
  onRevealSource,
  onLinkClickAnalytics,
}: {
  citation: Citation
  index: number
  interactive: boolean
  onOpenDocument: (citation: Citation, index: number) => void
  onRevealSource: (index: number) => void
  onLinkClickAnalytics?: (input: AssistantLinkClickAnalyticsInput) => void
}) => {
  // Non-interactive (link-only) surfaces cannot open the source document, but the
  // marker still reveals the matching source: it expands the sources panel,
  // scrolls it into view, and highlights the corresponding chip.
  if (!interactive) {
    return (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          onLinkClickAnalytics?.({
            linkType: 'citation_marker',
            citationIndex: index,
            documentId: citation.documentId,
            chunkId: citation.chunkId,
          })
          onRevealSource(index)
        }}
        className={`${CITATION_MARKER_BASE_CLASS} cursor-pointer hover:bg-primary/20 focus-visible:bg-primary/20 focus-visible:outline-none`}
        aria-label={`Show source ${index + 1}: ${getCitationLabel(citation, index)}`}
        data-citation-index={index + 1}
      >
        {index + 1}
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onLinkClickAnalytics?.({
          linkType: 'citation_marker',
          citationIndex: index,
          documentId: citation.documentId,
          chunkId: citation.chunkId,
        })
        void onOpenDocument(citation, index)
      }}
      className={`${CITATION_MARKER_BASE_CLASS} hover:bg-primary/20 focus-visible:bg-primary/20 focus-visible:outline-none`}
      aria-label={`Open source ${index + 1}: ${getCitationLabel(citation, index)}`}
      data-citation-index={index + 1}
    >
      {index + 1}
    </button>
  )
}

const SourceChip = ({
  citation,
  index,
  interactive,
  highlighted = false,
  onOpenDocument,
  onLinkClickAnalytics,
}: {
  citation: Citation
  index: number
  interactive: boolean
  highlighted?: boolean
  onOpenDocument: (citation: Citation, index: number) => void
  onLinkClickAnalytics?: (input: AssistantLinkClickAnalyticsInput) => void
}) => {
  const label = getCitationLabel(citation, index)
  const sourceUrl = citation.sourceUrl?.trim()
  const safeSourceUrl = sourceUrl && isSafeHref(sourceUrl) ? sourceUrl : null

  return (
    <span
      data-source-index={index + 1}
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs leading-5 transition-colors duration-300 ${
        highlighted ? 'border-primary bg-primary/10 ring-1 ring-primary/40' : 'border-border bg-card'
      }`}
    >
      <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary/10 px-1 text-[10px] font-semibold leading-none text-primary">
        {index + 1}
      </span>
      {interactive ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onLinkClickAnalytics?.({
              linkType: 'source_chip',
              citationIndex: index,
              documentId: citation.documentId,
              chunkId: citation.chunkId,
            })
            void onOpenDocument(citation, index)
          }}
          className="inline-flex max-w-full items-center gap-1 truncate text-left text-muted-foreground hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline focus-visible:outline-none"
          title={label}
        >
          <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{label}</span>
        </button>
      ) : (
        <span className="inline-flex max-w-full items-center gap-1 truncate text-left text-muted-foreground" title={label}>
          <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{label}</span>
        </span>
      )}
      {safeSourceUrl ? (
        <a
          href={safeSourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => {
            event.stopPropagation()
            onLinkClickAnalytics?.({
              linkType: 'citation_source_url',
              citationIndex: index,
              documentId: citation.documentId,
              chunkId: citation.chunkId,
              destinationUrl: safeSourceUrl,
            })
          }}
          className="inline-flex shrink-0 items-center text-primary hover:text-primary/80"
          aria-label={`Open ${label} in a new tab`}
          title={safeSourceUrl}
        >
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      ) : sourceUrl ? (
        <span className="inline-flex min-w-0 truncate text-muted-foreground" title={sourceUrl}>
          {sourceUrl}
        </span>
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
//
// Radioso answers in every language, so the terminator set comes from Unicode properties
// rather than an ASCII list: Terminal_Punctuation covers `.` `。` `、` `，` `！` `？` `؟` `،`
// `؛` `।` `॥` `።`, Pe the closing brackets, Pf the final quotes. Ellipsis and the straight
// quotes carry no such property and stay explicit. Opening delimiters are deliberately
// absent from all three properties, so `(`, `«` and `“` still stay with their own clause.
const SENTENCE_PUNCTUATION_CLASS = String.raw`\p{Terminal_Punctuation}\p{Pe}\p{Pf}…"'`
const SENTENCE_PUNCTUATION_ONLY_PATTERN = new RegExp(`^[\\s${SENTENCE_PUNCTUATION_CLASS}]+$`, 'u')
const LEADING_SENTENCE_PUNCTUATION_PATTERN = new RegExp(`^(\\s*)([${SENTENCE_PUNCTUATION_CLASS}]+)`, 'u')

const isPunctuationOnly = (text: string) => !WORD_CHAR_PATTERN.test(text)
const isSentencePunctuationOnly = (text: string) => SENTENCE_PUNCTUATION_ONLY_PATTERN.test(text)

const stripWhitespace = (text: string) => text.replace(/\s+/g, '')

// An anchor placed mid-sentence leaves the rest of that sentence in its own segment.
// Because every segment renders through its own markdown pass, that remainder would
// otherwise become a block of its own and drop onto a new line. Everything before the
// first real block boundary — a blank line, or a line opening a list, heading, quote,
// table or fence — continues the previous line instead. A lone newline is a soft break
// inside a paragraph, so it stays inside the run.
const BLOCK_BOUNDARY_PATTERN =
  /\n[ \t]*\n|\n(?=[ \t]{0,3}(?:[-+*][ \t]|\d+\.[ \t]|#{1,6}[ \t]|>|\||```|~~~))/

// A run absorbed onto a cited line renders as raw characters after the marker, so any
// run that markdown would transform has to stay in its own segment and keep its own
// pass. That covers inline delimiters and, because remark-gfm autolinks literals, bare
// URLs and email addresses too — absorbing those would turn a link into dead text.
const INLINE_MARKDOWN_PATTERN = /[*_~`[\]<>]/
const GFM_AUTOLINK_PATTERN = /https?:\/\/|www\.|[\w.+-]+@[\w-]+\.[\w-]+/i
// Markdown decodes character references, so an absorbed `R&amp;D` would reach the
// reader as literal `R&amp;D` instead of `R&D`.
const CHARACTER_REFERENCE_PATTERN = /&(?:[a-z]+|#\d+|#x[0-9a-f]+);/i

const rendersAsMarkdown = (run: string) =>
  INLINE_MARKDOWN_PATTERN.test(run)
  || GFM_AUTOLINK_PATTERN.test(run)
  || CHARACTER_REFERENCE_PATTERN.test(run)

const splitLeadingInlineRun = (text: string) => {
  const boundary = text.match(BLOCK_BOUNDARY_PATTERN)
  const cut = boundary?.index ?? text.length
  return { run: text.slice(0, cut), rest: text.slice(cut) }
}

// `trailingText` is sentence punctuation glued to the marker; `trailingContinuation` is
// the prose that carries on after it, which must stay wrappable.
type RenderableSegment = AnswerSegment & { trailingText?: string; trailingContinuation?: string }

// Detaches the leading run of `next` when it belongs on the previous segment's line,
// mutating `next` and returning the run. Returns null when the run must stay put.
const takeLeadingContinuation = (
  next: RenderableSegment,
  nextHasCitations: boolean,
  requireMarkdownSafe: boolean,
): string | null => {
  const { run, rest } = splitLeadingInlineRun(next.text)
  if (run.trim().length === 0) {
    return null
  }
  // A cited segment may only give up a run when a block boundary leaves its own marker
  // behind. Absorbing it whole would delete the segment and lose the citation with it.
  if (nextHasCitations && rest.length === 0) {
    return null
  }
  if (requireMarkdownSafe && rendersAsMarkdown(run)) {
    return null
  }

  next.text = rest
  return run
}

// Everything absorbed onto a cited line renders in source order after the marker:
// punctuation first, then any prose, then punctuation that followed that prose. Once a
// continuation has been taken, later punctuation belongs behind it, not in front.
const appendAfterMarker = (segment: RenderableSegment, text: string) => {
  if (segment.trailingContinuation !== undefined) {
    segment.trailingContinuation += text
    return
  }
  segment.trailingText = (segment.trailingText ?? '') + text
}

const appendContinuation = (segment: RenderableSegment, run: string) => {
  if (segment.trailingContinuation !== undefined) {
    segment.trailingContinuation += run
    return
  }
  // A separator space already sits in trailingText. Markdown would have stripped the
  // run's own block-edge whitespace, so drop it here rather than doubling the gap.
  segment.trailingContinuation = /\s$/.test(segment.trailingText ?? '')
    ? run.replace(/^[ \t]+/, '')
    : run
}

const attachDetachedCitationSegments = (
  segments: AnswerSegment[],
  citations: Citation[],
): RenderableSegment[] => {
  const normalized: RenderableSegment[] = []

  for (const segment of segments) {
    const citationIndices = getSegmentCitationIndices(segment, citations)
    const detachedCitationOnlySegment =
      citationIndices.length > 0 && (segment.text.length === 0 || isSentencePunctuationOnly(segment.text))
    const previous = normalized.at(-1)

    if (detachedCitationOnlySegment && previous) {
      previous.citationIndices = [
        ...new Set([...(previous.citationIndices ?? []), ...citationIndices]),
      ]
      const trailingText = stripWhitespace(segment.text)
      if (trailingText) {
        previous.trailingText = (previous.trailingText ?? '') + trailingText
      }
      continue
    }

    normalized.push({ ...segment })
  }

  return normalized
}

const redistributeLeadingPunctuation = (
  segments: AnswerSegment[],
  citations: Citation[],
): RenderableSegment[] => {
  const cloned = attachDetachedCitationSegments(segments, citations)

  for (let index = 0; index < cloned.length; index += 1) {
    const current = cloned[index]
    if (getSegmentCitationIndices(current, citations).length === 0) {
      // An uncited clause carries no marker, so trailing sentence punctuation the
      // model split onto its own segment can fold straight back into the prose.
      // Left alone it renders as a bare "." after the clause's block, dropping it
      // onto its own line.
      const next = cloned[index + 1]
      if (
        next &&
        current.text.length > 0 &&
        isSentencePunctuationOnly(next.text) &&
        getSegmentCitationIndices(next, citations).length === 0
      ) {
        const punct = stripWhitespace(next.text)
        if (punct) {
          current.text += punct
          next.text = ''
        }
      }

      // No marker sits between the two, so the run rejoins the prose in the same
      // markdown pass — markdown inside it still renders and needs no guard.
      if (next && current.text.length > 0 && next.text.length > 0) {
        const continuation = takeLeadingContinuation(
          next,
          getSegmentCitationIndices(next, citations).length > 0,
          false,
        )
        if (continuation) {
          current.text += continuation
        }
      }
      continue
    }

    let cursor = index + 1
    while (cursor < cloned.length) {
      const next = cloned[cursor]
      const nextHasCitations = getSegmentCitationIndices(next, citations).length > 0

      if (isSentencePunctuationOnly(next.text) && !nextHasCitations) {
        const punct = stripWhitespace(next.text)
        if (punct) {
          appendAfterMarker(current, punct)
        }
        next.text = ''
        cursor += 1
        continue
      }

      const leadingMatch = next.text.match(LEADING_SENTENCE_PUNCTUATION_PATTERN)
      if (leadingMatch) {
        const leadingWhitespace = leadingMatch[1]
        const leadingPunct = leadingMatch[2]
        const rest = next.text.slice(leadingMatch[0].length)
        const inlineRest = rest.replace(/^[ \t]+/, '')
        // When the cited clause's punctuation is followed by more of the same line,
        // a single space belongs between them. Each segment renders through its own
        // markdown pass, which strips block-edge whitespace, so any space left on
        // the next segment vanishes and glues the punctuation to the next word
        // ("2026[1].The", or "level[1],and" when the model itself dropped the
        // space). Normalize to exactly one separator carried in trailingText —
        // rendered as raw text after the marker — and strip the next segment's
        // leading inline whitespace so it never doubles up. A leading newline is a
        // block boundary and must stay on the next segment.
        const continuesInline = inlineRest.length > 0 && !/^[\r\n]/.test(inlineRest)
        // But an anchor can land inside a number ("EUR 18[[1]],00", "1[[1]].2"),
        // where the punctuation is a decimal/grouping mark, not a sentence break.
        // A digit immediately after it (no separating space in the source) means
        // the two sides are one number, so keep them tight — inserting a space
        // would change the value. A space before the digit is a real sentence
        // boundary and still gets the separator.
        const isNumericPunctuation = /^[\p{Nd}]/u.test(rest)
        const separator = continuesInline && !isNumericPunctuation ? ' ' : ''
        appendAfterMarker(current, leadingPunct + separator)
        next.text = continuesInline ? leadingWhitespace + inlineRest : leadingWhitespace + rest
      }

      // Whatever is left of the next segment's opening line finishes this segment's
      // sentence, so it renders after the marker instead of opening a block.
      const continuation = takeLeadingContinuation(next, nextHasCitations, true)
      if (continuation) {
        appendContinuation(current, continuation)
        if (next.text.length === 0 && !nextHasCitations) {
          cursor += 1
          continue
        }
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

// Identifies a citation for dedup purposes. Citations sharing a documentId
// collapse to a single source chip; chunk-only citations stay distinct.
const citationKey = (citation: Citation, index: number) =>
  citation.documentId || `${citation.chunkId}-${index}`

const collectUniqueCitations = (citations: Citation[]) => {
  const seen = new Set<string>()
  const unique: Array<{ citation: Citation; index: number }> = []

  for (let index = 0; index < citations.length; index += 1) {
    const citation = citations[index]
    if (!citation) {
      continue
    }
    const key = citationKey(citation, index)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    unique.push({ citation, index })
  }

  return unique
}

// Maps a clicked citation index to the index of the source chip that represents
// it, so revealing a duplicate-document citation highlights the rendered chip.
const resolveRepresentativeCitationIndex = (citations: Citation[], index: number) => {
  const target = citations[index]
  if (!target) {
    return index
  }
  const key = citationKey(target, index)
  const representative = citations.findIndex(
    (candidate, candidateIndex) => candidate && citationKey(candidate, candidateIndex) === key,
  )
  return representative >= 0 ? representative : index
}

export function AssistantMessageContent({
  content,
  citations = [],
  answerSegments,
  onOpenDocument,
  onLinkClickAnalytics,
  transformAssistantLinkHref,
  theme,
  isStreaming = false,
  showCitations = true,
  documentInteractivity = 'open',
}: AssistantMessageContentProps) {
  const citationsInteractive = documentInteractivity !== 'link-only'
  const [citationNotice, setCitationNotice] = useState<{ scope: string; message: string } | null>(null)
  const [sourcesExpanded, setSourcesExpanded] = useState(false)
  const [sourcesRendered, setSourcesRendered] = useState(false)
  // A reveal targets one source chip; the nonce lets repeated clicks on the same
  // marker re-trigger the scroll + highlight effect.
  const [reveal, setReveal] = useState<{ index: number; nonce: number } | null>(null)
  const revealNonceRef = useRef(0)
  const sourcesPanelRef = useRef<HTMLDivElement | null>(null)
  const sourcesPanelId = useId()
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
            interactive={citationsInteractive}
            onOpenDocument={handleCitationOpen}
            onRevealSource={handleRevealSource}
            onLinkClickAnalytics={onLinkClickAnalytics}
          />
        </Fragment>
      )
    })

  // Keeps the markers and the sentence punctuation the segment carries after
  // them on the same line as the word they annotate. Any trailing separator
  // space stays outside the nowrap span so the next word can still wrap.
  const renderCitationCluster = (citationIndices: number[], trailingText = '', continuation = '') => {
    const markers = renderCitations(citationIndices)
    const punctuation = trailingText.replace(/\s+$/, '')
    const separator = trailingText.slice(punctuation.length)

    if (markers.length === 0 && !punctuation) {
      return `${separator}${continuation}` || null
    }

    return (
      <>
        <span className="whitespace-nowrap">
          {CITATION_WORD_JOINER}
          {markers}
          {punctuation}
        </span>
        {separator}
        {continuation}
      </>
    )
  }

  const handleSourcesToggle = () => {
    if (sourcesExpanded) {
      setSourcesExpanded(false)
      return
    }

    setSourcesRendered(true)
    setSourcesExpanded(true)
  }

  const handleRevealSource = (index: number) => {
    const resolvedIndex = resolveRepresentativeCitationIndex(effectiveCitations, index)
    setSourcesRendered(true)
    setSourcesExpanded(true)
    revealNonceRef.current += 1
    setReveal({ index: resolvedIndex, nonce: revealNonceRef.current })
  }

  // Once the sources panel is open and a reveal is pending, bring the matching
  // chip into view and keep it highlighted briefly before clearing.
  useEffect(() => {
    if (!reveal || !sourcesExpanded) {
      return
    }

    const panel = sourcesPanelRef.current
    const target = panel?.querySelector<HTMLElement>(`[data-source-index="${reveal.index + 1}"]`)
    ;(target ?? panel)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })

    const timeout = window.setTimeout(() => {
      setReveal((current) => (current?.nonce === reveal.nonce ? null : current))
    }, 2200)

    return () => {
      window.clearTimeout(timeout)
    }
  }, [reveal, sourcesExpanded])

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
        trailingText?: string
        trailingContinuation?: string
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
          // Redistribution can move the rest of the item's sentence onto the segment;
          // it has to reach the cluster here or the prose is dropped from the render.
          trailingText: listSegment.trailingText,
          trailingContinuation: listSegment.trailingContinuation,
        })
        segmentIndex = listIndex
      }

      contentNodes.push(
        <ol key={`ordered-list-${segmentIndex}`} className="ml-5 list-decimal space-y-1 text-foreground">
          {listItems.map((item) => (
            <li key={item.key} value={item.number} className="ml-1 text-foreground">
              <AssistantMarkdownContent
                content={item.content}
                inline={!hasBlockMarkdown(item.content)}
                onLinkClick={(href) => {
                  onLinkClickAnalytics?.({
                    linkType: 'assistant_url',
                    destinationUrl: href,
                  })
                }}
                transformLinkHref={transformAssistantLinkHref}
              />
              {renderCitationCluster(
                item.citationIndices,
                item.trailingText ?? '',
                item.trailingContinuation ?? '',
              )}
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
    const trailingInlineContent =
      inline || (dedupedIndices.length === 0 && !segment.trailingText && !segment.trailingContinuation)
        ? null
        : renderCitationCluster(
          dedupedIndices,
          segment.trailingText ?? '',
          segment.trailingContinuation ?? '',
        )

    contentNodes.push(
      <Fragment key={`segment-${segmentIndex}`}>
        <AssistantMarkdownContent
          content={segment.text}
          inline={inline}
          trailingInlineContent={trailingInlineContent}
          onLinkClick={(href) => {
            onLinkClickAnalytics?.({
              linkType: 'assistant_url',
              destinationUrl: href,
            })
          }}
          transformLinkHref={transformAssistantLinkHref}
        />
        {inline
          ? renderCitationCluster(
            dedupedIndices,
            segment.trailingText ?? '',
            segment.trailingContinuation ?? '',
          )
          : null}
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
        <div className="pt-1 text-xs text-muted-foreground">
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1.5 rounded-full border border-transparent px-2.5 text-muted-foreground transition-colors duration-150 hover:border-border/70 hover:bg-muted/35 hover:text-foreground focus-visible:border-border focus-visible:bg-muted/45 focus-visible:text-foreground focus-visible:outline-none"
            aria-expanded={sourcesExpanded}
            aria-controls={sourcesPanelId}
            onClick={(event) => {
              event.stopPropagation()
              handleSourcesToggle()
            }}
          >
            <span className="font-semibold text-foreground">{uniqueCitations.length}</span>
            <span className="font-medium">Sources</span>
            <ChevronDown
              className={`h-3.5 w-3.5 opacity-70 transition-transform duration-150 ease-out ${sourcesExpanded ? '' : '-rotate-90'}`}
              aria-hidden="true"
            />
          </button>
          {sourcesRendered ? (
            <div
              id={sourcesPanelId}
              ref={sourcesPanelRef}
              className={`grid transition-[grid-template-rows,opacity,transform] duration-150 ease-out ${
                sourcesExpanded
                  ? 'mt-2 translate-y-0 grid-rows-[1fr] opacity-100'
                  : 'mt-1 -translate-y-1 grid-rows-[0fr] opacity-0'
              }`}
              aria-hidden={!sourcesExpanded}
              inert={!sourcesExpanded ? true : undefined}
              onTransitionEnd={(event) => {
                if (event.target === event.currentTarget && !sourcesExpanded) {
                  setSourcesRendered(false)
                }
              }}
            >
              <div className="flex min-h-0 flex-wrap items-baseline gap-x-3 gap-y-1.5 overflow-hidden">
                {uniqueCitations.map(({ citation, index }) => (
                  <SourceChip
                    key={`source-${citation.documentId}-${index}`}
                    citation={citation}
                    index={index}
                    interactive={citationsInteractive}
                    highlighted={reveal?.index === index}
                    onOpenDocument={handleCitationOpen}
                    onLinkClickAnalytics={onLinkClickAnalytics}
                  />
                ))}
              </div>
            </div>
          ) : null}
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
