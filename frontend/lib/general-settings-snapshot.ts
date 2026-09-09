import type { GeneralSettings } from './api-types'

/**
 * Merges a saved settings snapshot into the screen's draft.
 *
 * Every save on the assistant/channels screen answers with a whole-document snapshot the
 * server built when the request arrived, and several of them run concurrently. Uploading a
 * logo stores a new object and deletes the one it replaces, so a snapshot read before that
 * upload carries a logo URL whose bytes are already gone. Applying it blanks the preview,
 * and the image element latches the failed URL off for the rest of the session.
 *
 * `hasNewerLogo` says a logo write landed while this snapshot was in flight, in which case
 * the draft's URL is the current one and the snapshot's is not. The logo URL is otherwise
 * still the snapshot's to set, because it carries the public launch token and so changes
 * when a channel is toggled or a token is rotated.
 */
export const mergeGeneralSettingsSnapshot = (
  current: GeneralSettings | null,
  snapshot: GeneralSettings,
  { hasNewerLogo }: { hasNewerLogo: boolean },
): GeneralSettings =>
  hasNewerLogo && current ? { ...snapshot, assistantLogoUrl: current.assistantLogoUrl } : snapshot
