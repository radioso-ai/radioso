'use client'

import { useEffect } from 'react'

const carriesFiles = (event: DragEvent): boolean => Boolean(event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files'))

/**
 * Keeps the browser from opening a file dropped anywhere on the page, which would leave the chat.
 * A photo dropped on the composer is taken by the composer; one dropped elsewhere does nothing.
 * `window` covers the whole document, which is the frame's own document in the website embed.
 */
export function useFileDropGuard(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) {
      return
    }
    const refuseFiles = (event: DragEvent) => {
      if (carriesFiles(event)) {
        event.preventDefault()
      }
    }
    window.addEventListener('dragover', refuseFiles)
    window.addEventListener('drop', refuseFiles)
    return () => {
      window.removeEventListener('dragover', refuseFiles)
      window.removeEventListener('drop', refuseFiles)
    }
  }, [enabled])
}
