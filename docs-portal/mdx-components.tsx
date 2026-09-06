import type { MDXComponents } from 'mdx/types'
import type { ComponentProps, ElementType } from 'react'
import { useMDXComponents as getThemeComponents } from 'nextra-theme-docs'

import { MdxCodeBlock, MdxInlineCode } from '@/components/docs/mdx-code-block'
import { cn } from '@radioso/ui/utils'

const themeComponents = getThemeComponents()

/** Headings keep Nextra's anchor behaviour and pick up the brand display face. */
function withDisplayFont(Heading: ElementType): ElementType {
  return function DisplayHeading({ className, ...props }: ComponentProps<'h2'>) {
    return <Heading className={cn('font-display', className)} {...props} />
  }
}

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    ...themeComponents,
    h1: withDisplayFont(themeComponents.h1 as ElementType),
    h2: withDisplayFont(themeComponents.h2 as ElementType),
    h3: withDisplayFont(themeComponents.h3 as ElementType),
    h4: withDisplayFont(themeComponents.h4 as ElementType),
    h5: withDisplayFont(themeComponents.h5 as ElementType),
    h6: withDisplayFont(themeComponents.h6 as ElementType),
    // Every fenced code block renders in the branded surface with a copy button.
    // Nextra only applies the MDX `wrapper` to `app/**/page.mdx` files, so page
    // chrome (breadcrumbs, table of contents, pagination) lives in `DocsShell`
    // rather than in a wrapper that would never be invoked for `content/**`.
    pre: MdxCodeBlock,
    code: MdxInlineCode,
    ...components,
  }
}
