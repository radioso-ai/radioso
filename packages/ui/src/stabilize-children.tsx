import * as React from 'react'

/**
 * Wraps every bare string/number child in a stable `<span>` so React always has an element
 * to run DOM insert/remove operations against.
 *
 * Browser translation tools, some extensions, and password managers re-parent raw text
 * nodes (for example Google Translate wraps them in `<font>` tags). React keeps its own
 * reference to the original text node; the next time a sibling's presence or identity
 * changes, React calls `insertBefore`/`removeChild` against that stale reference and the
 * DOM throws `NotFoundError` because the node is no longer a direct child of its parent.
 * Any component that mixes literal text with a conditionally rendered sibling (a spinner
 * next to a label, an icon that swaps on hover state, a label that swaps on a loading
 * flag) carries this risk — auditing every call site by hand misses new ones as they're
 * added. Giving React only element children it fully owns removes the risk at the root.
 *
 * Recurses into Fragments only: a Fragment is a transparent grouping construct, not a real
 * component boundary, so its children are effectively direct children of the same DOM
 * parent. Any other element, including custom components, is left untouched — its own
 * children are its own concern.
 */
export function stabilizeChildren(children: React.ReactNode): React.ReactNode {
  return React.Children.map(children, (child) => {
    if (typeof child === 'string' || typeof child === 'number') {
      return <span>{child}</span>
    }
    if (React.isValidElement(child) && child.type === React.Fragment) {
      const fragmentProps = child.props as { children?: React.ReactNode }
      return React.cloneElement(child, undefined, stabilizeChildren(fragmentProps.children))
    }
    return child
  })
}
