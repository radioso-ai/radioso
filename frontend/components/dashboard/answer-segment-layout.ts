// Shapes an answer's citation-anchored segments for rendering: which punctuation and
// prose rejoin a cited line after its marker, and which segments are list items that
// render together as one list. Pure transforms over AnswerSegment; no React.
import { type AnswerSegment, type Citation } from '@/lib/api'

const ORDERED_LIST_ITEM_PATTERN = /^(\s*)(\d+)\.\s+([\s\S]+)$/
// One bullet item on one line, so consecutive cited items can join a single list.
const BULLET_LIST_ITEM_PATTERN = /^\s*[-*+][ \t]+([^\r\n]+?)\s*$/

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

export const isPunctuationOnly = (text: string) => !WORD_CHAR_PATTERN.test(text)
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
type RenderableSegment = AnswerSegment & {
  trailingText?: string
  trailingContinuation?: string
  /** The punctuation after the marker is a decimal or grouping mark inside a number. */
  trailingJoinsNumber?: boolean
}

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

export const redistributeLeadingPunctuation = (
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
        if (isNumericPunctuation) {
          current.trailingJoinsNumber = true
        }
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

export const getSegmentCitationIndices = (segment: AnswerSegment, citations: Citation[]) =>
  [...new Set(segment.citationIndices ?? [])].filter(
    (index) => index >= 0 && index < citations.length,
  )

type ListItemSegment =
  | { ordered: true; number: number; content: string }
  | { ordered: false; content: string }

const BULLET_LINE_PATTERN = /^[ \t]*[-*+][ \t]+\S/

// A list whose opening sentence carries no marker arrives with its first items in that
// sentence's segment. Splitting the segment's closing run of bullet lines into one
// segment per item lets those items join the rest of the list; the segment's markers
// belong to its last line.
export const splitClosingBulletRun = (segment: AnswerSegment): AnswerSegment[] => {
  const lines = segment.text.split('\n')
  let end = lines.length
  while (end > 0 && lines[end - 1].trim() === '') {
    end -= 1
  }
  let start = end
  while (start > 0 && BULLET_LINE_PATTERN.test(lines[start - 1])) {
    start -= 1
  }
  const prefix = lines.slice(0, start).join('\n')
  const itemCount = end - start
  if (itemCount === 0 || (itemCount === 1 && prefix.trim() === '')) {
    return [segment]
  }
  const items = lines.slice(start, end)
  return [
    ...(prefix.trim() ? [{ text: prefix }] : []),
    ...items.map((line, index) =>
      index === items.length - 1 ? { ...segment, text: `\n${line}` } : { text: `\n${line}` },
    ),
  ]
}

export const getListItem = (segment: AnswerSegment): ListItemSegment | null => {
  const ordered = segment.text.match(ORDERED_LIST_ITEM_PATTERN)
  if (ordered) {
    return { ordered: true, number: Number(ordered[2]), content: ordered[3] }
  }
  const bullet = segment.text.match(BULLET_LIST_ITEM_PATTERN)
  return bullet ? { ordered: false, content: bullet[1] } : null
}
