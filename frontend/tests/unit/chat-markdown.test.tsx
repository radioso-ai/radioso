import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { AssistantMarkdownContent } from '@/components/dashboard/chat-markdown'

describe('AssistantMarkdownContent', () => {
  it('renders the supported markdown subset as semantic markup', () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdownContent
        content={`Intro **bold** text.

Inline \`code\`, a [link](https://example.com), and a list:

- First item
- Second item

> Quoted text

\`\`\`ts
const value = 1
\`\`\``}
      />,
    )

    expect(html).toMatch(/<strong[^>]*>bold<\/strong>/)
    expect(html).toMatch(/<code[^>]*>code<\/code>/)
    expect(html).toContain('href="https://example.com"')
    expect(html).toMatch(/<ul[^>]*>/)
    expect(html).toMatch(/<blockquote[^>]*>/)
    expect(html).toMatch(/<pre[^>]*>/)
    expect(html).toContain('const value = 1')
  })

  it('treats single newlines as normal markdown whitespace', () => {
    const html = renderToStaticMarkup(<AssistantMarkdownContent content={'First line\nSecond line'} />)

    expect(html).not.toContain('<br/>')
    expect(html).toContain('Second line')
  })

  it('renders markdown paragraphs when separated by a blank line', () => {
    const html = renderToStaticMarkup(<AssistantMarkdownContent content={'First paragraph\n\nSecond paragraph'} />)

    expect(html).toContain('<p')
    expect(html).toContain('First paragraph')
    expect(html).toContain('Second paragraph')
  })

  it('autolinks bare http urls in assistant text', () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdownContent content={'Visit https://example.com for more details.'} />,
    )

    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('https://example.com')
  })

  it('suppresses images in chat output', () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdownContent content={'Some text\n\n![tracking](https://evil.com/pixel.png)'} />,
    )

    expect(html).not.toContain('<img')
  })

  it('expands inline unordered markers into a real markdown list', () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdownContent
        content={
          'If you want, I can help with - a question about Ananda or related events • a reflection or practical step for self-realization + finding a friendly next step'
        }
      />,
    )

    expect(html).toContain('<ul')
    expect(html).toContain('<li')
  })

  it('does not expand dash-separated prose into a list', () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdownContent content={'Hours: 9 - 5 - weekdays only'} />,
    )

    expect(html).not.toContain('<ul')
    expect(html).toContain('Hours: 9 - 5 - weekdays only')
  })

  it('keeps a link whose label contains " - " intact instead of breaking it into a list', () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdownContent
        content={
          'For the specific course title, you can look at [RESIDENTIAL COURSE: ARYTT - Raja Yoga Teaching 3 - How to be a Spiritual Teacher: Methodology](https://corsi.ananda.it/en/course/0006334-x) or [RESIDENTIAL COURSE: LTS - Raja Yoga Teaching 3 - How to be a Spiritual Teacher: Methodology](https://corsi.ananda.it/en/course/0007850-x).'
        }
      />,
    )

    // Both links render as intact anchors, not shattered into bullet markup.
    expect(html).toContain('href="https://corsi.ananda.it/en/course/0006334-x"')
    expect(html).toContain('href="https://corsi.ananda.it/en/course/0007850-x"')
    expect(html).not.toContain('<ul')
    expect(html).not.toContain('<li')
    // The full title survives as the link label (no injected line breaks).
    expect(html).toMatch(
      /RESIDENTIAL COURSE: ARYTT - Raja Yoga Teaching 3 - How to be a Spiritual Teacher: Methodology/,
    )
  })
})
