import { describe, expect, it } from 'vitest'
import * as React from 'react'

import { stabilizeChildren } from '@radioso/ui/stabilize-children'

// stabilizeChildren gives React a stable element to run DOM insert/remove operations
// against wherever JSX would otherwise hand it a bare text node. Browser translation tools
// re-parent raw text nodes into wrapper elements (e.g. Google Translate's <font> tags);
// React keeps its own reference to the original node and throws NotFoundError the next time
// it needs to insertBefore/removeChild relative to it. Wrapping every bare string/number
// child in a <span> means React only ever holds references to elements it fully owns.
describe('stabilizeChildren', () => {
  it('wraps a bare string child in a span', () => {
    const result = React.Children.toArray(stabilizeChildren('Sign In'))
    expect(result).toHaveLength(1)
    const [child] = result
    expect(React.isValidElement(child)).toBe(true)
    expect((child as React.ReactElement).type).toBe('span')
    expect((child as React.ReactElement<{ children?: React.ReactNode }>).props.children).toBe('Sign In')
  })

  it('wraps a bare number child in a span', () => {
    const [child] = React.Children.toArray(stabilizeChildren(42))
    expect((child as React.ReactElement).type).toBe('span')
  })

  it('leaves non-text elements untouched', () => {
    // React.Children.map re-keys every element it passes through (new wrapper object,
    // same type/props), so assert structure rather than reference identity.
    const icon = <svg data-testid="icon" />
    const [child] = React.Children.toArray(stabilizeChildren(icon)) as React.ReactElement[]
    expect(child.type).toBe('svg')
    expect(child.props).toBe(icon.props)
  })

  it('wraps only the bare text among mixed element and text children', () => {
    const icon = <svg data-testid="icon" />
    const result = React.Children.toArray(stabilizeChildren([icon, 'Sign In'])) as React.ReactElement[]
    expect(result).toHaveLength(2)
    expect(result[0].type).toBe('svg')
    expect(result[0].props).toBe(icon.props)
    expect(result[1].type).toBe('span')
    expect((result[1].props as { children?: React.ReactNode }).children).toBe('Sign In')
  })

  it('passes through null and false slots used by conditional rendering', () => {
    // toArray drops null/false/undefined; only the wrapped label should remain.
    const result = React.Children.toArray(stabilizeChildren([null, 'Label', false])) as React.ReactElement[]
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('span')
    expect((result[0].props as { children?: React.ReactNode }).children).toBe('Label')
  })

  it('recurses into a Fragment, wrapping the bare text inside it', () => {
    const icon = <svg data-testid="icon" />
    const fragment = (
      <>
        {icon}
        Saving…
      </>
    )
    // React.Children.map always returns an array, even for a single input element.
    const [stabilized] = React.Children.toArray(stabilizeChildren(fragment)) as React.ReactElement[]
    expect(stabilized.type).toBe(React.Fragment)
    const innerChildren = React.Children.toArray(
      (stabilized.props as { children?: React.ReactNode }).children,
    ) as React.ReactElement[]
    expect(innerChildren[0].type).toBe('svg')
    expect(innerChildren[0].props).toBe(icon.props)
    expect(innerChildren[1].type).toBe('span')
    expect((innerChildren[1].props as { children?: React.ReactNode }).children).toBe('Saving…')
  })

  it('does not recurse into an arbitrary custom component', () => {
    function Label({ children }: { children: React.ReactNode }) {
      return <>{children}</>
    }
    const element = <Label>Save</Label>
    const [child] = React.Children.toArray(stabilizeChildren(element)) as React.ReactElement[]
    // Only Fragments are transparent; a real component's own children are its own concern.
    expect(child.type).toBe(Label)
    expect(child.props).toBe(element.props)
  })
})
