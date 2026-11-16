import { AGENT_DRAFT_SAVED_EVENT } from './agent-draft-save-port'
import type { VoiceCallReadiness } from './api-types'
import { AGENT_VOICE_SAVED_EVENT } from './voice-settings-form'

/** What the backend names as missing; the API contract lists them, so a new one fails this file until it has a hint. */
type VoiceCallReadinessGap = NonNullable<VoiceCallReadiness['missing']>

const HINTS: Record<VoiceCallReadinessGap, (vendorName: string) => string> = {
  publication: () => 'Publish the agent first: until it is published, it answers no chats or calls.',
  voice_channel: () => 'Turn on the voice channel on the API page first.',
  // The Voice card's switch reads off while nothing is bound; turning it on connects.
  runtime: () => 'Turn on the voice channel on the API page first.',
  vendor_key: (vendorName) => `Store the ${vendorName} key under Settings → Providers first.`,
  encryption: (vendorName) =>
    `Radioso cannot read the stored ${vendorName} key. Check CONNECTOR_ENCRYPTION_KEY; after a key rotation, list the key it replaced in CONNECTOR_ENCRYPTION_PREVIOUS_KEYS. Otherwise enter the key again.`,
}

/**
 * The one line that says what the agent's voice still needs, for the piece the backend names as
 * missing: Talk in the test chat shows it, and the Voice card shows the publication. `vendorName`
 * is the bound runtime's vendor; `missing` is absent when the page could not learn readiness.
 */
export function voiceCallReadinessHint(missing: VoiceCallReadinessGap | null | undefined, vendorName: string): string {
  return missing ? HINTS[missing](vendorName) : 'Publish the agent and turn on its voice channel on the API page first.'
}

/**
 * The gaps the website's calls switch sets up in place: turning it on turns the agent's voice on,
 * which connects the vendor and asks for its key when needed. A publication or an unreadable stored
 * key it cannot fix.
 */
const SET_UP_IN_PLACE: Partial<Record<VoiceCallReadinessGap, (vendorName: string) => string>> = {
  voice_channel: (vendorName) => `Turning it on sets up the agent’s voice on ${vendorName}.`,
  runtime: (vendorName) => `Turning it on connects ${vendorName} for this agent.`,
  vendor_key: (vendorName) => `Turning it on asks for the ${vendorName} API key.`,
}

/**
 * What turning the website's calls switch on does: offers calls at once when voice is ready, sets
 * voice up first when the missing piece is one it can set up, and nothing otherwise (`hint` names the
 * piece). Unknown readiness counts as not ready.
 */
type WebsiteCallsSwitch =
  | { kind: 'ready' }
  | { kind: 'sets_up_voice'; hint: string }
  | { kind: 'blocked'; hint: string }

export function websiteCallsSwitchOf(readiness: VoiceCallReadiness | null | undefined, vendorName: string): WebsiteCallsSwitch {
  if (readiness?.ready) return { kind: 'ready' }
  const setUp = readiness?.missing ? SET_UP_IN_PLACE[readiness.missing] : undefined
  return setUp
    ? { kind: 'sets_up_voice', hint: setUp(vendorName) }
    : { kind: 'blocked', hint: voiceCallReadinessHint(readiness?.missing, vendorName) }
}

/**
 * Calls `read` whenever the agent's voice readiness may have changed: voice was switched, saved,
 * connected or disconnected, the agent was published, or the window regained focus (the vendor key lives
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
