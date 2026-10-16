import type { AgentVoiceSettings } from './api-types'
import { providerDisplayName } from './api-llm-providers'

/**
 * Whether an agent's voice is ready for the website embed to offer calls, and when it is not, the
 * first piece the operator still has to set up. It mirrors the backend's gate on a session start
 * (voice on, a runtime bound, the vendor's key stored), which stays the authority: this only decides
 * what the dashboard lets the operator switch on and which hint it shows.
 */
export type VoiceCallReadiness =
  | { ready: true }
  | { ready: false; missing: 'voice_channel' | 'runtime' | 'unknown' }
  | { ready: false; missing: 'vendor_key'; vendorName: string }

/** `storedProviders` is null when the page could not read which keys the workspace stores. */
export function voiceCallReadiness(input: {
  voice: Pick<AgentVoiceSettings, 'enabled' | 'runtime'>
  storedProviders: readonly string[] | null
}): VoiceCallReadiness {
  if (!input.voice.enabled) return { ready: false, missing: 'voice_channel' }
  const runtime = input.voice.runtime
  if (!runtime) return { ready: false, missing: 'runtime' }
  if (input.storedProviders === null) return { ready: false, missing: 'unknown' }
  return input.storedProviders.includes(runtime.vendor)
    ? { ready: true }
    : { ready: false, missing: 'vendor_key', vendorName: providerDisplayName[runtime.vendor] }
}

/** The one line the switch shows while calls cannot be offered. */
export function voiceCallReadinessHint(readiness: Exclude<VoiceCallReadiness, { ready: true }>): string {
  switch (readiness.missing) {
    case 'voice_channel':
      return 'Turn on the voice channel on the API page first.'
    case 'runtime':
      return 'Bind a voice runtime on the Voice card first.'
    case 'vendor_key':
      return `Store the ${readiness.vendorName} key under Settings → Providers first.`
    case 'unknown':
      return 'Turn on the voice channel, bind a runtime and store the vendor key first.'
  }
}
