import type { VoiceCallReadiness } from './api-types'

/**
 * The one line the website widget's calls switch shows while the agent's voice is not ready, for
 * the piece the backend names as missing. `vendorName` is the bound runtime's vendor; `missing` is
 * absent when the page could not learn readiness, and then every piece is named.
 */
export function voiceCallReadinessHint(missing: VoiceCallReadiness['missing'] | undefined, vendorName: string): string {
  switch (missing) {
    case 'voice_channel':
      return 'Turn on the voice channel on the API page first.'
    case 'runtime':
      return 'Bind a voice runtime on the Voice card first.'
    case 'vendor_key':
      return `Store the ${vendorName} key under Settings → Providers first.`
    case 'encryption':
      return `Radioso cannot read the stored ${vendorName} key. Set CONNECTOR_ENCRYPTION_KEY, then enter the key again.`
    default:
      return 'Turn on the voice channel, bind a runtime and store the vendor key first.'
  }
}
