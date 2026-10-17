import { voiceVendorNames, type VoiceVendorName } from '@/lib/api-llm-providers'
import type { AgentMechanicsReplies, AgentVoiceSettings } from '@/lib/api-types'

export const VOICE_BRIDGE_STYLES = ['check', 'acknowledge'] as const
export type VoiceBridgeStyle = (typeof VOICE_BRIDGE_STYLES)[number]

export const MECHANICS_REPLY_KINDS = ['greeting', 'thanks', 'farewell', 'acknowledgement'] as const
export type MechanicsReplyKind = (typeof MECHANICS_REPLY_KINDS)[number]

/** The agent settings API's bounds, mirrored so the editor stops where a save would be refused. */
export const VOICE_MAX_LANGUAGES = 10
export const VOICE_MAX_LINES = 5
export const VOICE_MAX_LINE_LENGTH = 200

/**
 * The shortest first sentence the `elevenlabs` voice dialect speaks before more text arrives, so a
 * shorter bridge or fallback line waits for the answer. Mirrors
 * `ELEVENLABS_MIN_RELEASABLE_SENTENCE_CHARS` in `backend/src/modules/voiceChannel/public.ts`;
 * `backend/tests/unit/voice-channel-dialects.test.ts` pins the two together.
 */
export const ELEVENLABS_MIN_RELEASABLE_SENTENCE_CHARS = 45

/** A written line the `elevenlabs` dialect holds back; other dialects have no floor, so this only warns. */
export const isBelowElevenLabsSpokenFloor = (line: string): boolean => {
  const text = line.trim()
  return text.length > 0 && Array.from(text).length < ELEVENLABS_MIN_RELEASABLE_SENTENCE_CHARS
}

/** The data residency regions a vendor account can be in, from the generated contract. */
export type VoiceRuntimeRegion = NonNullable<AgentVoiceSettings['runtime']>['region']
const listEveryRegion = <const Regions extends readonly VoiceRuntimeRegion[]>(
  regions: Regions & (Exclude<VoiceRuntimeRegion, Regions[number]> extends never ? unknown : never),
) => regions
/** In the order the card offers them; `us` is the vendor's default region. */
export const VOICE_RUNTIME_REGIONS = listEveryRegion(['us', 'eu', 'in', 'sg'])

/**
 * The agent settings API's bound on a vendor agent id. Mirrors `maxLength` on
 * `AgentVoiceSettings.runtime.agentId` in the OpenAPI contract; `tests/unit/voice-settings-form.test.ts`
 * pins the two together.
 */
export const VOICE_RUNTIME_AGENT_ID_MAX_LENGTH = 128

/** The vendor agent a Radioso-started voice session opens; a blank `agentId` binds none. */
export interface VoiceRuntimeForm {
  vendor: VoiceVendorName
  agentId: string
  region: VoiceRuntimeRegion
}

/** One language's lines across the `voice` and `mechanicsReplies` blocks. */
export interface VoiceLanguageLines {
  locale: string
  bridgeLines: Record<VoiceBridgeStyle, string[]>
  fallbackLine: string
  /** Shown to a caller from the website embed as the call starts; blank shows none. */
  recordingNotice: string
  mechanicsReplies: Record<MechanicsReplyKind, string[]>
}

export interface VoiceSettingsForm {
  enabled: boolean
  runtime: VoiceRuntimeForm
  languages: VoiceLanguageLines[]
}

const linesOf = <Kind extends string>(kinds: readonly Kind[], source?: Partial<Record<Kind, string[]>>): Record<Kind, string[]> =>
  Object.fromEntries(kinds.map((kind) => [kind, [...(source?.[kind] ?? [])]])) as Record<Kind, string[]>

export const emptyVoiceLanguageLines = (locale: string): VoiceLanguageLines => ({
  locale,
  bridgeLines: linesOf(VOICE_BRIDGE_STYLES),
  fallbackLine: '',
  recordingNotice: '',
  mechanicsReplies: linesOf(MECHANICS_REPLY_KINDS),
})

/** Both blocks as one entry per language tag, in the order each tag first appears. */
export const voiceSettingsFormFromAgent = (voice: AgentVoiceSettings, mechanicsReplies: AgentMechanicsReplies): VoiceSettingsForm => {
  const recordingNotices = voice.recordingNotice ?? {}
  const locales = [...new Set([
    ...Object.keys(voice.bridgeLines),
    ...Object.keys(voice.fallbackLine),
    ...Object.keys(recordingNotices),
    ...Object.keys(mechanicsReplies),
  ])]
  return {
    enabled: voice.enabled,
    runtime: voice.runtime ? { ...voice.runtime } : { vendor: voiceVendorNames[0], agentId: '', region: VOICE_RUNTIME_REGIONS[0] },
    languages: locales.map((locale) => ({
      locale,
      bridgeLines: linesOf(VOICE_BRIDGE_STYLES, voice.bridgeLines[locale]),
      fallbackLine: voice.fallbackLine[locale] ?? '',
      recordingNotice: recordingNotices[locale] ?? '',
      mechanicsReplies: linesOf(MECHANICS_REPLY_KINDS, mechanicsReplies[locale]),
    })),
  }
}

const authored = (lines: readonly string[]): string[] => lines.map((line) => line.trim()).filter((line) => line.length > 0)

const authoredLinesOf = <Kind extends string>(kinds: readonly Kind[], source: Record<Kind, string[]>): Record<Kind, string[]> | null => {
  const lines = Object.fromEntries(kinds.map((kind) => [kind, authored(source[kind])])) as Record<Kind, string[]>
  return kinds.some((kind) => lines[kind].length > 0) ? lines : null
}

/**
 * The whole `voice` and `mechanicsReplies` blocks the form describes, as an agent update replaces
 * them. Blank lines are dropped, and a language with nothing in a block is left out of that block.
 */
export const voiceSettingsUpdateFromForm = (form: VoiceSettingsForm): { voice: AgentVoiceSettings; mechanicsReplies: AgentMechanicsReplies } => {
  const agentId = form.runtime.agentId.trim()
  const runtime = agentId ? { vendor: form.runtime.vendor, agentId, region: form.runtime.region } : null
  const voice: AgentVoiceSettings = { enabled: form.enabled, bridgeLines: {}, fallbackLine: {}, runtime }
  const recordingNotice: Record<string, string> = {}
  const mechanicsReplies: AgentMechanicsReplies = {}
  for (const language of form.languages) {
    const bridgeLines = authoredLinesOf(VOICE_BRIDGE_STYLES, language.bridgeLines)
    if (bridgeLines) voice.bridgeLines[language.locale] = bridgeLines
    const fallbackLine = language.fallbackLine.trim()
    if (fallbackLine) voice.fallbackLine[language.locale] = fallbackLine
    const notice = language.recordingNotice.trim()
    if (notice) recordingNotice[language.locale] = notice
    const replies = authoredLinesOf(MECHANICS_REPLY_KINDS, language.mechanicsReplies)
    if (replies) mechanicsReplies[language.locale] = replies
  }
  // The block is replaced whole, so leaving the notices out removes every one.
  if (Object.keys(recordingNotice).length > 0) voice.recordingNotice = recordingNotice
  return { voice, mechanicsReplies }
}

/**
 * The form once a save returns: `enabled`, the runtime and every language's lines as the server stored them,
 * with the form's own language list kept, so a language added with nothing in it yet stays until
 * the operator removes it.
 */
export const voiceSettingsFormAfterSave = (form: VoiceSettingsForm, voice: AgentVoiceSettings, mechanicsReplies: AgentMechanicsReplies): VoiceSettingsForm => {
  const saved = voiceSettingsFormFromAgent(voice, mechanicsReplies)
  const savedByLocale = new Map(saved.languages.map((language) => [language.locale, language]))
  const kept = form.languages.map((language) => savedByLocale.get(language.locale) ?? emptyVoiceLanguageLines(language.locale))
  const keptLocales = new Set(kept.map((language) => language.locale))
  return {
    enabled: saved.enabled,
    runtime: saved.runtime,
    languages: [...kept, ...saved.languages.filter((language) => !keptLocales.has(language.locale))],
  }
}

/**
 * Sent on the window after the Voice card saves an agent's voice settings, with `{ agentId }`, so
 * what reads that agent's voice readiness, such as the website widget's calls switch, reads it again.
 */
export const AGENT_VOICE_SAVED_EVENT = 'radioso:agent-voice-saved'
