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

  it('suppresses images and flattens headings to chat-friendly text blocks', () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdownContent content={'# Big title\n\n![tracking](https://evil.com/pixel.png)'} />,
    )

    expect(html).not.toContain('<img')
    expect(html).not.toContain('<h1')
    expect(html).toContain('Big title')
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
})
