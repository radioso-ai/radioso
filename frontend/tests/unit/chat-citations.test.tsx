import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { AssistantMessageContent } from '@/components/dashboard/chat-citations'

// Collapses rendered markup to its visible text so assertions can check the
// spacing a reader actually sees, independent of element boundaries.
const textContent = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')

// The citation cluster must render inside the block it annotates. If it escapes,
// it lands right after that block's closing tag and drops onto its own line.
const ESCAPED_CITATION_CLUSTER = /<\/(?:p|ul|ol)>\s*<span class="whitespace-nowrap">/

// The visible block structure a reader perceives — one entry per rendered paragraph.
const paragraphTexts = (html: string) =>
  [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map(([, inner]) =>
    inner.replace(/<[^>]+>/g, '').replace(/⁠/g, '').replace(/\s+/g, ' ').trim(),
  )

const listItemTexts = (html: string) =>
  [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map(([, inner]) =>
    inner.replace(/<[^>]+>/g, '').replace(/⁠/g, '').replace(/\s+/g, ' ').trim(),
  )

describe('AssistantMessageContent', () => {
  it('keeps citation markers attached to markdown-rendered segments', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[
          {
            documentId: 'doc-1',
            chunkId: 'chunk-1',
            title: 'Source 1',
          },
        ]}
        answerSegments={[
          {
            text: 'This is **important** evidence.',
            citationIndices: [0],
          },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).toContain('data-citation-index="1"')
  })

  it('suppresses citation markers when citation display is disabled', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="This is important evidence."
        citations={[
          {
            documentId: 'doc-1',
            chunkId: 'chunk-1',
            title: 'Source 1',
          },
        ]}
        answerSegments={[
          {
            text: 'This is **important** evidence.',
            citationIndices: [0],
          },
        ]}
        onOpenDocument={async () => 'opened'}
        showCitations={false}
      />,
    )

    expect(html).not.toContain('data-citation-index')
    expect(html).toContain('This is important evidence.')
  })

  it('keeps bare urls clickable inside cited inline segments', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[
          {
            documentId: 'doc-1',
            chunkId: 'chunk-1',
            title: 'Source 1',
          },
        ]}
        answerSegments={[
          {
            text: 'See https://example.com for context.',
            citationIndices: [0],
          },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).toContain('href="https://example.com"')
  })

  it('does not turn citation-separated sentences into line breaks', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[
          {
            documentId: 'doc-1',
            chunkId: 'chunk-1',
            title: 'Source 1',
          },
          {
            documentId: 'doc-2',
            chunkId: 'chunk-2',
            title: 'Source 2',
          },
        ]}
        answerSegments={[
          {
            text: 'First sentence',
            citationIndices: [0],
          },
          {
            text: '.\nSecond sentence',
            citationIndices: [1],
          },
          {
            text: '.',
          },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).not.toContain('<br/>')
    expect(html).toContain('First sentence')
    expect(html).toContain('Second sentence')
  })

  it('preserves paragraph markdown inside cited block segments', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[
          {
            documentId: 'doc-1',
            chunkId: 'chunk-1',
            title: 'Source 1',
          },
        ]}
        answerSegments={[
          {
            text: 'First paragraph.\n\nSecond paragraph with a [link](https://example.com).',
            citationIndices: [0],
          },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).toContain('<p')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('Second paragraph')
    expect(html).toMatch(/Second paragraph[\s\S]*data-citation-index="1"[\s\S]*<\/button><\/span><\/p>/)
    expect(html).not.toMatch(ESCAPED_CITATION_CLUSTER)
  })

  it('keeps citation markers inside the final list item of cited block segments', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[
          {
            documentId: 'doc-1',
            chunkId: 'chunk-1',
            title: 'Source 1',
          },
        ]}
        answerSegments={[
          {
            text: 'Preparation includes:\n\n- Daily meditation\n- Advanced techniques',
            citationIndices: [0],
          },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).toMatch(/Advanced techniques[\s\S]*data-citation-index="1"[\s\S]*<\/button><\/span><\/li>\s*<\/ul>/)
    expect(html).not.toMatch(ESCAPED_CITATION_CLUSTER)
  })

  it('keeps citation markers inside cited list-item segments with trailing whitespace', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[
          {
            documentId: 'doc-1',
            chunkId: 'chunk-1',
            title: 'Source 1',
          },
        ]}
        answerSegments={[
          {
            text: '- Realize who you are: you are a divine being, not limited by fear or lack. ',
            citationIndices: [0],
          },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).toMatch(/lack\.[\s\S]*data-citation-index="1"[\s\S]*<\/button><\/span><\/li>\s*<\/ul>/)
    expect(html).not.toMatch(ESCAPED_CITATION_CLUSTER)
  })

  it('renders every marker from routine-retrieval segments split across bullets and links', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[
          { documentId: 'doc-1', chunkId: 'chunk-1', title: 'Source 1' },
          { documentId: 'doc-2', chunkId: 'chunk-2', title: 'Source 2' },
          { documentId: 'doc-3', chunkId: 'chunk-3', title: 'Source 3' },
          { documentId: 'doc-4', chunkId: 'chunk-4', title: 'Source 4' },
        ]}
        answerSegments={[
          { text: 'Life is a journey. ' },
          { text: 'It is about aligning with truth.\n' },
          { text: '\nA few inviting ideas to explore:\n', citationIndices: [0] },
          {
            text: '- Realize who you are: you are a divine being, not limited by fear or lack. ',
            citationIndices: [1],
          },
          { text: 'This remembrance can change how you respond. ' },
          { text: 'You can read more in [Discover Who You Are!](' },
          { text: 'https://corsi.ananda.it/en/blog/discover-who-you-are)\n' },
          {
            text: '- Practice inner calm: through simple meditation and breath, you can steady the mind. ',
            citationIndices: [2],
          },
          {
            text: 'Learn more at [Ananda](https://www.ananda.org)\n',
            citationIndices: [3],
          },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html.match(/data-citation-index="/g)).toHaveLength(4)
    expect(html).toContain('data-citation-index="1"')
    expect(html).toContain('data-citation-index="2"')
    expect(html).toContain('data-citation-index="3"')
    expect(html).toContain('data-citation-index="4"')
  })

  it('reattaches historical citation-only segments to the preceding block segment', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[
          {
            documentId: 'doc-1',
            chunkId: 'chunk-1',
            title: 'Source 1',
          },
        ]}
        answerSegments={[
          {
            text: 'Preparation includes:\n\n- Daily meditation\n- Advanced techniques',
          },
          {
            text: '\n\n',
            citationIndices: [0],
          },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).toMatch(/Advanced techniques[\s\S]*data-citation-index="1"[\s\S]*<\/button><\/span><\/li>\s*<\/ul>/)
    expect(html).not.toMatch(ESCAPED_CITATION_CLUSTER)
  })

  it('renders a collapsed Sources disclosure with the unique source count', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[
          { documentId: 'doc-1', chunkId: 'chunk-1', title: 'Retrieval guide' },
          { documentId: 'doc-2', chunkId: 'chunk-2', title: 'Architecture' },
          { documentId: 'doc-1', chunkId: 'chunk-3', title: 'Retrieval guide' },
        ]}
        answerSegments={[
          { text: 'Alpha', citationIndices: [0] },
          { text: ' and beta', citationIndices: [1] },
          { text: '.', citationIndices: [2] },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).toContain('Sources')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toMatch(/<span class="font-semibold text-foreground">2<\/span><span class="font-medium">Sources<\/span>/)
    expect(html).not.toContain('title="Retrieval guide"')
    expect(html).not.toContain('title="Architecture"')
  })

  it('hides source URL affordances while the Sources disclosure is collapsed', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[
          {
            documentId: 'doc-1',
            chunkId: 'chunk-1',
            title: 'Radioso overview',
            sourceUrl: 'https://example.com/overview',
          },
        ]}
        answerSegments={[
          { text: 'Radioso is self-hosted', citationIndices: [0] },
          { text: '.' },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).toContain('Sources')
    expect(html).not.toContain('href="https://example.com/overview"')
  })

  it('omits the external-link affordance for sources without a sourceUrl', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[
          { documentId: 'doc-1', chunkId: 'chunk-1', title: 'Local file' },
        ]}
        answerSegments={[
          { text: 'Documented in the manual', citationIndices: [0] },
          { text: '.' },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).not.toContain('target="_blank"')
    expect(html).toContain('Local file')
  })

  it('renders an interactive citation marker that can open the source by default', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[{ documentId: 'doc-1', chunkId: 'chunk-1', title: 'Handbook' }]}
        answerSegments={[{ text: 'Grounded', citationIndices: [0] }, { text: '.' }]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).toContain('aria-label="Open source 1: Handbook"')
  })

  it('renders link-only citation markers as reveal buttons, not document openers', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[{ documentId: '', chunkId: '', title: 'Handbook', sourceUrl: 'https://example.com/h' }]}
        answerSegments={[{ text: 'Grounded', citationIndices: [0] }, { text: '.' }]}
        onOpenDocument={async () => 'unavailable'}
        documentInteractivity="link-only"
      />,
    )

    // The marker is clickable, but it reveals the source chip below rather than
    // offering to open the underlying document.
    expect(html).toContain('data-citation-index="1"')
    expect(html).toContain('aria-label="Show source 1: Handbook"')
    expect(html).not.toContain('aria-label="Open source 1')
  })

  it('absorbs a leading period of a multi-paragraph segment into the prior marker line', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[
          { documentId: 'doc-1', chunkId: 'chunk-1', title: 'Source 1' },
        ]}
        answerSegments={[
          { text: 'Arya is the author of the post', citationIndices: [0] },
          { text: '.\n\nHer story traces a path from Hong Kong', citationIndices: [0] },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    // The leading "." on the second segment should not render as <p>.</p>
    expect(html).not.toMatch(/<p[^>]*>\s*\.\s*<\/p>/)
    expect(html).toContain('Her story')
  })

  it('binds the markers and their sentence punctuation into one unbreakable cluster', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[
          { documentId: 'doc-1', chunkId: 'chunk-1', title: 'Source 1' },
          { documentId: 'doc-2', chunkId: 'chunk-2', title: 'Source 2' },
        ]}
        answerSegments={[
          { text: 'the Italian version is [Calendario corsi](https://example.com)', citationIndices: [0, 1] },
          { text: '. We also have the broader calendar' },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    // Both markers and the period share one nowrap span, so none of them can wrap
    // away from "corsi" and open the next line on their own.
    const cluster = html.match(/<span class="whitespace-nowrap">[\s\S]*?<\/span>(?!<\/button>)/)?.[0] ?? ''
    expect(cluster).toContain('data-citation-index="1"')
    expect(cluster).toContain('data-citation-index="2"')
    expect(cluster.endsWith('.</span>')).toBe(true)
    // U+2060 WORD JOINER glues the cluster to the preceding word.
    expect(cluster).toMatch(/^<span class="whitespace-nowrap">⁠/)
    // The separator space stays outside the span so the next word can still wrap.
    expect(html).toContain('.</span> ')
    expect(cluster).not.toMatch(/\s<\/span>$/)
  })

  // Radioso answers in any language, so the clause terminator that follows a marker
  // is not always a Latin full stop. Whatever the script, it belongs on the marker's
  // line — never opening the next block.
  it.each([
    ['Latin', 'The calendar is here', '.', ' We also run retreats.'],
    ['Chinese', '课程日历在这里', '。', '我们还举办静修。'],
    ['Japanese', 'コース日程はこちら', '。', 'リトリートもあります。'],
    ['Arabic', 'تقويم الدورات هنا', '؟', ' لدينا أيضا خلوات.'],
    ['Devanagari', 'पाठ्यक्रम कैलेंडर यहाँ है', '।', ' हम रिट्रीट भी चलाते हैं।'],
    ['Ethiopic', 'የኮርስ የቀን መቁጠሪያ እዚህ አለ', '።', ' ሪትሪትም እናደርጋለን።'],
  ])('keeps the %s clause terminator on the marker line', async (_script, prose, terminator, tail) => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[{ documentId: 'doc-1', chunkId: 'chunk-1', title: 'Source 1' }]}
        answerSegments={[
          { text: prose, citationIndices: [0] },
          { text: terminator + tail },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).toContain(`${terminator}</span>`)
    expect(html).not.toMatch(new RegExp(`<p[^>]*>\\s*\\${terminator}`))
  })

  // A mid-sentence anchor leaves the rest of the sentence in its own segment. That
  // remainder continues the same line, so it must not open a block of its own.
  it('keeps the uncited remainder of a sentence on the cited line', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[{ documentId: 'doc-1', chunkId: 'chunk-1', title: 'Source 1' }]}
        answerSegments={[
          { text: '\n\nWe also have the broader [Events Calendar](https://example.com)', citationIndices: [0] },
          { text: ' for Europe.' },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(paragraphTexts(html)).toEqual(['We also have the broader Events Calendar1 for Europe.'])
  })

  it('pulls a cited segment’s leading run back onto the previous line', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[
          { documentId: 'doc-1', chunkId: 'chunk-1', title: 'Source 1' },
          { documentId: 'doc-2', chunkId: 'chunk-2', title: 'Source 2' },
        ]}
        answerSegments={[
          { text: 'コース日程は **重要なお知らせ**', citationIndices: [0] },
          { text: ' です。\n\n詳しくは [イベント日程](https://example.com)', citationIndices: [1] },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    // "です。" closes the first sentence, so it stays with marker 1; the paragraph
    // break still starts a genuine second block.
    expect(paragraphTexts(html)).toEqual(['詳しくは イベント日程2'])
    expect(html).toContain('です。')
    expect(html.indexOf('です。')).toBeLessThan(html.indexOf('詳しくは'))
  })

  it('leaves a remainder that opens a new paragraph as its own block', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[{ documentId: 'doc-1', chunkId: 'chunk-1', title: 'Source 1' }]}
        answerSegments={[
          { text: '\n\nThe calendar is published', citationIndices: [0] },
          { text: ' each spring.\n\nBooking is open.' },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(paragraphTexts(html)).toEqual([
      'The calendar is published1 each spring.',
      'Booking is open.',
    ])
  })

  // Absorbed text renders as raw characters after the marker, so anything markdown
  // would style must stay in its own segment and keep its own markdown pass.
  it('does not absorb a remainder containing inline markdown', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[{ documentId: 'doc-1', chunkId: 'chunk-1', title: 'Source 1' }]}
        answerSegments={[
          { text: '\n\nThe calendar is published', citationIndices: [0] },
          { text: ' every **spring**.' },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).toContain('<strong')
    expect(html).not.toContain('**spring**')
  })

  // Absorbed runs render as raw characters, so anything remark-gfm would have turned
  // into a link has to stay in its own segment and keep its markdown pass.
  it('does not absorb a remainder containing a bare URL', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[{ documentId: 'doc-1', chunkId: 'chunk-1', title: 'Source 1' }]}
        answerSegments={[
          { text: 'See details', citationIndices: [0] },
          { text: ' at https://example.com for dates.' },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).toContain('href="https://example.com"')
  })

  it('does not absorb a remainder containing a bare email address', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[{ documentId: 'doc-1', chunkId: 'chunk-1', title: 'Source 1' }]}
        answerSegments={[
          { text: 'Ask the office', citationIndices: [0] },
          { text: ' at info@example.com for dates.' },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).toContain('href="mailto:info@example.com"')
  })

  it('does not absorb a remainder containing a character reference', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[{ documentId: 'doc-1', chunkId: 'chunk-1', title: 'Source 1' }]}
        answerSegments={[
          { text: 'The course runs', citationIndices: [0] },
          { text: ' for R&amp;D teams.' },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).toContain('R&amp;D teams.')
    expect(html).not.toContain('&amp;amp;')
  })

  // An ordered-list segment renders through a dedicated branch. Anything redistribution
  // moved onto it must reach that branch too, or the prose is silently deleted.
  it('keeps a continuation absorbed onto an ordered-list item', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[{ documentId: 'doc-1', chunkId: 'chunk-1', title: 'Source 1' }]}
        answerSegments={[
          { text: '1. Event runs from 9', citationIndices: [0] },
          { text: ' to 5.' },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(listItemTexts(html)).toEqual(['Event runs from 91 to 5.'])
  })

  it('keeps punctuation absorbed onto an ordered-list item', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[{ documentId: 'doc-1', chunkId: 'chunk-1', title: 'Source 1' }]}
        answerSegments={[
          { text: '1. Event runs all day', citationIndices: [0] },
          { text: '.' },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(listItemTexts(html)).toEqual(['Event runs all day1.'])
  })

  it('never absorbs a cited inline continuation, which would drop its marker', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[
          { documentId: 'doc-1', chunkId: 'chunk-1', title: 'Source 1' },
          { documentId: 'doc-2', chunkId: 'chunk-2', title: 'Source 2' },
        ]}
        answerSegments={[
          { text: 'The calendar is published', citationIndices: [0] },
          { text: ' and the Italian one too', citationIndices: [1] },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).toContain('data-citation-index="1"')
    expect(html).toContain('data-citation-index="2"')
  })

  it('absorbs a punctuation+paragraph-break segment between cited segments', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[
          { documentId: 'doc-1', chunkId: 'chunk-1', title: 'Source 1' },
        ]}
        answerSegments={[
          { text: 'First paragraph', citationIndices: [0] },
          { text: '.\n\n' },
          { text: 'Second paragraph' },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).not.toMatch(/<p[^>]*>\s*\.\s*<\/p>/)
    expect(html).toContain('Second paragraph')
  })

  it('absorbs a leading punctuation run that begins with whitespace', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[
          { documentId: 'doc-1', chunkId: 'chunk-1', title: 'Source 1' },
        ]}
        answerSegments={[
          { text: 'First grounded line', citationIndices: [0] },
          { text: ' .\n\nNext content begins here' },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).not.toMatch(/<p[^>]*>\s*\.\s*Next content/)
    expect(html).toContain('Next content begins here')
  })

  it('keeps trailing punctuation segments inline with their citation marker', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[
          { documentId: 'doc-1', chunkId: 'chunk-1', title: 'Source 1' },
        ]}
        answerSegments={[
          { text: 'You can also visit the centennial page', citationIndices: [0] },
          { text: '.' },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    // The lone "." should not produce its own paragraph block beneath the marker.
    expect(html).not.toMatch(/<p[^>]*>\s*\.\s*<\/p>/)
  })

  it('does not strip leading markdown from the segment after a citation', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[
          { documentId: 'doc-1', chunkId: 'chunk-1', title: 'Source 1' },
        ]}
        answerSegments={[
          { text: 'See the overview', citationIndices: [0] },
          { text: ' **Important** detail follows.' },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    // The bold marker must survive and render as <strong>, not be pulled onto the marker line.
    expect(html).toContain('<strong')
    expect(html).toContain('Important')
    expect(html).not.toContain('**Important')
  })

  it('does not strip a leading markdown link from the next segment', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[
          { documentId: 'doc-1', chunkId: 'chunk-1', title: 'Source 1' },
        ]}
        answerSegments={[
          { text: 'More context here', citationIndices: [0] },
          { text: ' [link](https://example.com) closes it.' },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).toContain('href="https://example.com"')
  })

  it('keeps a space between a citation marker and the following sentence', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[
          { documentId: 'doc-1', chunkId: 'chunk-1', title: 'Source 1' },
        ]}
        answerSegments={[
          { text: 'all from 21 to 23 August 2026', citationIndices: [0] },
          { text: '. The first-Kriya programs are limited.' },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    // The period must not glue to the next sentence ("2026[1].The").
    expect(textContent(html)).toContain('. The first-Kriya')
    expect(textContent(html)).not.toContain('.The first-Kriya')
  })

  it('keeps a space between a citation marker and a following clause after a comma', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[
          { documentId: 'doc-1', chunkId: 'chunk-1', title: 'Source 1' },
        ]}
        answerSegments={[
          { text: 'initiated at that level', citationIndices: [0] },
          { text: ', and the higher-Kriya weekend is separate.' },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(textContent(html)).toContain(', and the higher-Kriya')
    expect(textContent(html)).not.toContain(',and the higher-Kriya')
  })

  it('normalizes seam spacing the model or anchor removal mangled', async () => {
    // Segments the backend actually emits when the model writes a space before the
    // anchor / punctuation and drops the one after: " . We…" and " ,and…".
    const period = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[{ documentId: 'doc-1', chunkId: 'chunk-1', title: 'Source 1' }]}
        answerSegments={[
          { text: 'from 17:00 to 19:30', citationIndices: [0] },
          { text: ' . We also have a residential course.' },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )
    expect(textContent(period)).toContain('19:30')
    expect(textContent(period)).toContain('. We also have')
    expect(textContent(period)).not.toContain(' . We also have')
    expect(textContent(period)).not.toContain('.We also have')

    const comma = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[{ documentId: 'doc-1', chunkId: 'chunk-1', title: 'Source 1' }]}
        answerSegments={[
          { text: 'initiated at that level', citationIndices: [0] },
          { text: ' ,and the higher-Kriya weekend is separate.' },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )
    expect(textContent(comma)).toContain(', and the higher-Kriya')
    expect(textContent(comma)).not.toContain(' ,and')
    expect(textContent(comma)).not.toContain(',and the higher')
  })

  it('does not insert a space inside a number split by a citation anchor', async () => {
    const decimal = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[{ documentId: 'doc-1', chunkId: 'chunk-1', title: 'Source 1' }]}
        answerSegments={[
          { text: 'the retreat costs EUR 18', citationIndices: [0] },
          { text: ',00 per person.' },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )
    // The marker renders between "18" and ",00", so assert on the punctuation
    // seam itself: the decimal stays tight, with no injected space.
    expect(textContent(decimal)).toContain(',00 per person')
    expect(textContent(decimal)).not.toContain(', 00')

    const version = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[{ documentId: 'doc-1', chunkId: 'chunk-1', title: 'Source 1' }]}
        answerSegments={[
          { text: 'runs on version 1', citationIndices: [0] },
          { text: '.2 of the platform.' },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )
    expect(textContent(version)).toContain('.2 of the platform')
    expect(textContent(version)).not.toContain('. 2')

    // A space before the digit is a genuine sentence boundary, not a number, so
    // the separator is still restored.
    const sentence = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[{ documentId: 'doc-1', chunkId: 'chunk-1', title: 'Source 1' }]}
        answerSegments={[
          { text: 'attendance grew in 2026', citationIndices: [0] },
          { text: '. 3 sessions ran that week.' },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )
    expect(textContent(sentence)).toContain('. 3 sessions ran')
    expect(textContent(sentence)).not.toContain('.3 sessions')
  })

  it('does not orphan a trailing period after an uncited continuation', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[
          { documentId: 'doc-1', chunkId: 'chunk-1', title: 'Source 1' },
        ]}
        answerSegments={[
          { text: 'RESIDENTIAL COURSE January 2025', citationIndices: [0] },
          { text: ', but the excerpt available here does not show its dates' },
          { text: '.' },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    // The final period must stay inside the clause's block, not render as a bare
    // text node after the closing </p> (which drops it onto its own line).
    expect(html).toContain('its dates.')
    expect(html).not.toMatch(/dates<\/p>\s*\./)
  })

  it('does not crash on out-of-range numeric entities in titles', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[
          { documentId: 'doc-1', chunkId: 'chunk-1', title: 'Bad &#9999999999; entity' },
        ]}
        answerSegments={[
          { text: 'See bad title', citationIndices: [0] },
          { text: '.' },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    // Undecodable entity is left as text rather than throwing during render.
    expect(html).toContain('&amp;#9999999999;')
  })

  it('decodes HTML entities in source titles', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[
          { documentId: 'doc-1', chunkId: 'chunk-1', title: 'Aryavan McSweeney &mdash; Ananda &amp; Co.' },
        ]}
        answerSegments={[
          { text: 'See bio', citationIndices: [0] },
          { text: '.' },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).toContain('Aryavan McSweeney — Ananda &amp; Co.')
    expect(html).not.toContain('&mdash;')
  })

  it('preserves ordered lists when citations are attached per item', async () => {
    const html = renderToStaticMarkup(
      <AssistantMessageContent
        content="unused"
        citations={[
          {
            documentId: 'doc-1',
            chunkId: 'chunk-1',
            title: 'Source 1',
          },
          {
            documentId: 'doc-2',
            chunkId: 'chunk-2',
            title: 'Source 2',
          },
        ]}
        answerSegments={[
          {
            text: '1. **Start small.** Begin with five minutes.',
            citationIndices: [0],
          },
          {
            text: '2. **Stay consistent.** Pick the same time each day.',
            citationIndices: [1],
          },
        ]}
        onOpenDocument={async () => 'opened'}
      />,
    )

    expect(html).toContain('<ol')
    expect(html).toContain('<li')
  })
})
