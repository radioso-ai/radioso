// Where focus sits and how much viewport the embed has: the shell reads these to
// keep the composer visible above an on-screen keyboard and to leave typing
// keys to the control that has them.
const isEditableElement = (element: Element | null) => {
  if (!element) {
    return false
  }

  const tagName = element.tagName.toLowerCase()
  return tagName === 'textarea' || tagName === 'input' || (element instanceof HTMLElement && element.isContentEditable)
}

export const isTypingControl = (element: EventTarget | null) => {
  if (!(element instanceof Element)) {
    return false
  }

  if (isEditableElement(element)) {
    return true
  }

  const tagName = element.tagName.toLowerCase()
  return tagName === 'button' || tagName === 'a' || tagName === 'select'
}

export function readWebsiteEmbedViewportSnapshot() {
  if (typeof window === 'undefined') {
    return {
      viewportWidth: Number.POSITIVE_INFINITY,
      layoutViewportHeight: Number.POSITIVE_INFINITY,
      visualViewportHeight: null,
      editableFocused: false,
    }
  }

  const visualViewport = window.visualViewport

  return {
    viewportWidth: visualViewport?.width ?? window.innerWidth,
    layoutViewportHeight: window.innerHeight,
    visualViewportHeight: visualViewport?.height ?? null,
    editableFocused: isEditableElement(document.activeElement),
  }
}
