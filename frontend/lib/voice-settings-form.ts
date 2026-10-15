import type { AgentMechanicsReplies, AgentVoiceSettings } from '@/lib/api-types'

export const VOICE_BRIDGE_STYLES = ['check', 'acknowledge'] as const
export type VoiceBridgeStyle = (typeof VOICE_BRIDGE_STYLES)[number]

export const MECHANICS_REPLY_KINDS = ['greeting', 'thanks', 'farewell', 'acknowledgement'] as const
export type MechanicsReplyKind = (typeof MECHANICS_REPLY_KINDS)[number]

/** The agent settings API's bounds, mirrored so the editor stops where a save would be refused. */
export const VOICE_MAX_LANGUAGES = 10
export const VOICE_MAX_LINES = 5
export const VOICE_MAX_LINE_LENGTH = 200

/** One language's lines across the `voice` and `mechanicsReplies` blocks. */
export interface VoiceLanguageLines {
  locale: string
  bridgeLines: Record<VoiceBridgeStyle, string[]>
  fallbackLine: string
  mechanicsReplies: Record<MechanicsReplyKind, string[]>
}

export interface VoiceSettingsForm {
  enabled: boolean
  languages: VoiceLanguageLines[]
}

const linesOf = <Kind extends string>(kinds: readonly Kind[], source?: Partial<Record<Kind, string[]>>): Record<Kind, string[]> =>
  Object.fromEntries(kinds.map((kind) => [kind, [...(source?.[kind] ?? [])]])) as Record<Kind, string[]>

export const emptyVoiceLanguageLines = (locale: string): VoiceLanguageLines => ({
  locale,
  bridgeLines: linesOf(VOICE_BRIDGE_STYLES),
  fallbackLine: '',
  mechanicsReplies: linesOf(MECHANICS_REPLY_KINDS),
})

/** Both blocks as one entry per language tag, in the order each tag first appears. */
export const voiceSettingsFormFromAgent = (voice: AgentVoiceSettings, mechanicsReplies: AgentMechanicsReplies): VoiceSettingsForm => {
  const locales = [...new Set([...Object.keys(voice.bridgeLines), ...Object.keys(voice.fallbackLine), ...Object.keys(mechanicsReplies)])]
  return {
    enabled: voice.enabled,
    languages: locales.map((locale) => ({
      locale,
      bridgeLines: linesOf(VOICE_BRIDGE_STYLES, voice.bridgeLines[locale]),
      fallbackLine: voice.fallbackLine[locale] ?? '',
      mechanicsReplies: linesOf(MECHANICS_REPLY_KINDS, mechanicsReplies[locale]),
    })),
  }
}

const authored = (lines: readonly string[]): string[] => lines.map((line) => line.trim()).filter((line) => line.length > 0)

/**
 * The whole `voice` and `mechanicsReplies` blocks the form describes, as an agent update replaces
 * them. Blank lines are dropped, and a language with nothing in a block is left out of that block.
 */
export const voiceSettingsUpdateFromForm = (form: VoiceSettingsForm): { voice: AgentVoiceSettings; mechanicsReplies: AgentMechanicsReplies } => {
  const voice: AgentVoiceSettings = { enabled: form.enabled, bridgeLines: {}, fallbackLine: {} }
  const mechanicsReplies: AgentMechanicsReplies = {}
  for (const language of form.languages) {
    const bridgeLines = { acknowledge: authored(language.bridgeLines.acknowledge), check: authored(language.bridgeLines.check) }
    if (bridgeLines.acknowledge.length > 0 || bridgeLines.check.length > 0) voice.bridgeLines[language.locale] = bridgeLines
    const fallbackLine = language.fallbackLine.trim()
    if (fallbackLine) voice.fallbackLine[language.locale] = fallbackLine
    const replies = {
      greeting: authored(language.mechanicsReplies.greeting),
      thanks: authored(language.mechanicsReplies.thanks),
      farewell: authored(language.mechanicsReplies.farewell),
      acknowledgement: authored(language.mechanicsReplies.acknowledgement),
    }
    if (Object.values(replies).some((lines) => lines.length > 0)) mechanicsReplies[language.locale] = replies
  }
  return { voice, mechanicsReplies }
}
