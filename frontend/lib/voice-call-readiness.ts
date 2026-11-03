import type { VoiceCallReadiness } from './api-types'
import { AGENT_VOICE_SAVED_EVENT } from './voice-settings-form'

/** What the backend names as missing; the API contract lists them, so a new one fails this file until it has a hint. */
type VoiceCallReadinessGap = NonNullable<VoiceCallReadiness['missing']>

const HINTS: Record<VoiceCallReadinessGap, (vendorName: string) => string> = {
  publication: () => 'Publish the agent first: until it is published, it answers no chats or calls.',
  voice_channel: () => 'Turn on the voice channel on the API page first.',
  runtime: () => 'Connect a voice runtime on the Voice card first.',
  vendor_key: (vendorName) => `Store the ${vendorName} key under Settings → Providers first.`,
  encryption: (vendorName) =>
    `Radioso cannot read the stored ${vendorName} key. Check CONNECTOR_ENCRYPTION_KEY; after a key rotation, list the key it replaced in CONNECTOR_ENCRYPTION_PREVIOUS_KEYS. Otherwise enter the key again.`,
}

/**
 * The one line that says what the agent's voice still needs, for the piece the backend names as
 * missing: the website widget's calls switch shows it, and the Voice card shows the publication.
 * `vendorName` is the bound runtime's vendor; `missing` is absent when the page could not learn
 * readiness, and then every piece is named.
 */
export function voiceCallReadinessHint(missing: VoiceCallReadinessGap | null | undefined, vendorName: string): string {
  return missing ? HINTS[missing](vendorName) : 'Turn on the voice channel, store the vendor key and connect a runtime first.'
}

/** Sent on the window, with `{ agentId }`, after the agent's draft is saved or a revision of it is published. */
const AGENT_DRAFT_SAVED_EVENT = 'radioso:agent-draft-saved'

/**
 * Calls `read` whenever the agent's voice readiness may have changed: the Voice card saved it or
 * connected a runtime, the agent was published, or the window regained focus (the vendor key lives
 * under Settings → Providers, and a publication may come from another tab). Returns the unsubscribe.
 */
export function onVoiceCallReadinessChange(agentId: string, read: () => void): () => void {
  const readForAgent = (event: Event) => {
    if ((event as CustomEvent<{ agentId?: string }>).detail?.agentId === agentId) read()
  }
  window.addEventListener('focus', read)
  window.addEventListener(AGENT_VOICE_SAVED_EVENT, readForAgent)
  window.addEventListener(AGENT_DRAFT_SAVED_EVENT, readForAgent)
  return () => {
    window.removeEventListener('focus', read)
    window.removeEventListener(AGENT_VOICE_SAVED_EVENT, readForAgent)
    window.removeEventListener(AGENT_DRAFT_SAVED_EVENT, readForAgent)
  }
}
