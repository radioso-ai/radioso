import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { AssistantMessageContent } from '@/components/dashboard/chat-citations'

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
    expect(html).toMatch(/Second paragraph[\s\S]*data-citation-index="1"[\s\S]*<\/button><\/p>/)
    expect(html).not.toContain('</p><button')
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

    expect(html).toMatch(/Advanced techniques[\s\S]*data-citation-index="1"[\s\S]*<\/button><\/li>\s*<\/ul>/)
    expect(html).not.toContain('</ul><button')
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

    expect(html).toMatch(/Advanced techniques[\s\S]*data-citation-index="1"[\s\S]*<\/button><\/li>\s*<\/ul>/)
    expect(html).not.toContain('</ul><button')
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
