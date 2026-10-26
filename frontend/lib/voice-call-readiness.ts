import type { VoiceCallReadiness } from './api-types'

/** What the backend names as missing; the API contract lists them, so a new one fails this file until it has a hint. */
type VoiceCallReadinessGap = NonNullable<VoiceCallReadiness['missing']>

const HINTS: Record<VoiceCallReadinessGap, (vendorName: string) => string> = {
  voice_channel: () => 'Turn on the voice channel on the API page first.',
  runtime: () => 'Connect a voice runtime on the Voice card first.',
  vendor_key: (vendorName) => `Store the ${vendorName} key under Settings → Providers first.`,
  encryption: (vendorName) =>
    `Radioso cannot read the stored ${vendorName} key. Check CONNECTOR_ENCRYPTION_KEY; after a key rotation, list the key it replaced in CONNECTOR_ENCRYPTION_PREVIOUS_KEYS. Otherwise enter the key again.`,
}

/**
 * The one line the website widget's calls switch shows while the agent's voice is not ready, for
 * the piece the backend names as missing. `vendorName` is the bound runtime's vendor; `missing` is
 * absent when the page could not learn readiness, and then every piece is named.
 */
export function voiceCallReadinessHint(missing: VoiceCallReadinessGap | null | undefined, vendorName: string): string {
  return missing ? HINTS[missing](vendorName) : 'Turn on the voice channel, store the vendor key and connect a runtime first.'
}
