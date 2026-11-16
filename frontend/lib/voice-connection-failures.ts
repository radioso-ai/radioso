import { getApiErrorCode, getApiErrorMessage } from './api-error'
import type { VoiceVendorName } from './api-llm-providers'
import type { AgentVoiceConnection } from './api-types'

/** The vendor Radioso connects when an agent with no runtime bound turns its voice on. */
export const CONNECT_VOICE_VENDOR: VoiceVendorName = 'elevenlabs'

/** What the dashboard says for each way a voice change can fail; the API's `error.code` names the way. */
const CONNECTION_FAILURES: Record<string, (vendor: string) => string> = {
  voice_vendor_key_missing: (vendor) => `Add your ${vendor} API key under Settings → Providers first.`,
  voice_vendor_key_unreadable: (vendor) => `Radioso can’t read the stored ${vendor} key. Enter it again under Settings → Providers.`,
  voice_vendor_key_rejected: (vendor) => `${vendor} didn’t accept the stored API key. Check the key under Settings → Providers.`,
  voice_vendor_key_lacks_agents_permission: (vendor) =>
    `The ${vendor} key needs the Agents permission, read and write. Turn it on for the key in ${vendor}, or store a key that has it.`,
  voice_vendor_unreachable: (vendor) => `${vendor} didn’t answer. Try again in a moment.`,
  voice_vendor_failed: (vendor) => `${vendor} wouldn’t set up the agent. Try again; if it keeps failing, contact support.`,
  voice_connection_busy: () => 'Another change to this agent’s voice is still running. Try again in a moment.',
  voice_connection_unavailable: (vendor) =>
    `${vendor} can’t reach this Radioso deployment: its address (APP_BASE_URL) isn’t reachable from the internet. Ask your administrator to fix it.`,
}

/** The one line for a failed Connect, Disconnect or voice switch: the closed reason when the API names one, else its message. */
export function voiceConnectionFailureMessage(error: unknown, vendorName: string, fallback: string): string {
  const failure = CONNECTION_FAILURES[getApiErrorCode(error) ?? '']
  return failure ? failure(vendorName) : getApiErrorMessage(error, fallback)
}

/** Why turning voice on needs the vendor's API key: each is fixed by storing a key that works. */
export type VoiceVendorKeyProblem = 'missing' | 'unreadable' | 'rejected' | 'lacks_agents_permission'

const KEY_PROBLEM_OF_CODE: Record<string, VoiceVendorKeyProblem> = {
  voice_vendor_key_missing: 'missing',
  voice_vendor_key_unreadable: 'unreadable',
  voice_vendor_key_rejected: 'rejected',
  voice_vendor_key_lacks_agents_permission: 'lacks_agents_permission',
}

/** The key problem a failed voice switch names, or null when storing another key would not help. */
export function voiceVendorKeyProblemOfError(error: unknown): VoiceVendorKeyProblem | null {
  return KEY_PROBLEM_OF_CODE[getApiErrorCode(error) ?? ''] ?? null
}

/**
 * The key problem left after voice went on: an agent with a runtime already bound turns on without
 * calling the vendor, so the answer may report no usable key, and calls would fail until one is stored.
 */
export function voiceVendorKeyProblemOfConnection(connection: Pick<AgentVoiceConnection, 'vendorKey'>): VoiceVendorKeyProblem | null {
  return connection.vendorKey === 'stored' ? null : connection.vendorKey
}

const KEY_PROBLEM_LINES: Record<VoiceVendorKeyProblem, (vendor: string) => string> = {
  missing: (vendor) => `Add your ${vendor} API key. It needs the Agents permission, read and write.`,
  unreadable: (vendor) => `Radioso can’t read the stored ${vendor} key. Enter it again.`,
  rejected: (vendor) => `${vendor} didn’t accept the stored key. Enter one that works.`,
  lacks_agents_permission: (vendor) => `The ${vendor} key lacks the Agents permission, read and write. Enter a key that has it.`,
}

/** The one line the key dialog opens with. */
export function voiceVendorKeyProblemLine(problem: VoiceVendorKeyProblem, vendorName: string): string {
  return KEY_PROBLEM_LINES[problem](vendorName)
}
