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

  it('preserves visible line breaks in assistant text', () => {
    const html = renderToStaticMarkup(<AssistantMarkdownContent content={'First line\nSecond line'} />)

    expect(html).toContain('First line<br/>')
    expect(html).toContain('Second line')
  })
})
