import type { CSSProperties } from 'react'

import type { WebsiteEmbedTheme } from '@/lib/embed-widget'
import { quietIconForeground } from '@/lib/public-chat-theme'

/** The colours a quiet icon button in the composer draws with: the embed's theme, or the dashboard's CSS variables. */
export type ComposerIconTheme = Pick<WebsiteEmbedTheme, 'inputBackground' | 'inputForeground' | 'mutedBackground' | 'mutedForeground'>

/**
 * The one treatment the composer's icon buttons beside Send share (the paperclip and Talk): no fill
 * at rest, and a neutral fill on hover and press. The ghost variant hovers on the page's accent,
 * which is yellow in the dashboard, so the hover is the theme's muted surface instead, for light and
 * dark alike. The focus ring is the button's own. Send keeps its own styling.
 */
export const composerIconButtonClass =
  'shrink-0 rounded-full hover:bg-[var(--composer-icon-hover)] active:bg-[var(--composer-icon-hover)] dark:hover:bg-[var(--composer-icon-hover)]'

/** The glyph colour, at least 3:1 on the field, and the surface the button takes on hover and press. */
export const composerIconButtonStyle = (theme: ComposerIconTheme): CSSProperties => ({
  color: quietIconForeground(theme),
  ['--composer-icon-hover' as string]: theme.mutedBackground,
})
