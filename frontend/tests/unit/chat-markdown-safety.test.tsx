import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { AssistantMarkdownContent } from '@/components/dashboard/chat-markdown'

describe('AssistantMarkdownContent safety', () => {
  it('keeps raw HTML inert', () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdownContent content={'Hello <script>alert("xss")</script> world'} />,
    )

    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;')
  })

  it('downgrades unsafe link targets to inert text', () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdownContent content={'[Unsafe link](javascript:alert("xss"))'} />,
    )

    expect(html).not.toContain('href="javascript:alert')
    expect(html).toContain('Unsafe link')
  })
})
