'use client'

import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Loader2, Send } from 'lucide-react'

import { VoiceCallBar, VoiceCallNotice, VoiceTalkButton, type VoiceCallTheme } from '@/components/chat/voice-call-controls'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { agentsApi } from '@/lib/api'
import { agentRevisionsApi, type TestExecutionHistoryDetail } from '@/lib/api-agent-revisions'
import { providerDisplayName } from '@/lib/api-llm-providers'
import { startTestChatVoiceSession } from '@/lib/api-test-chat-voice'
import { DEFAULT_WEBSITE_EMBED_COPY } from '@/lib/embed-widget'
import { useCanAskForMicrophone, useVoiceSession } from '@/lib/use-voice-session'
import { onVoiceCallReadinessChange, voiceCallReadinessHint } from '@/lib/voice-call-readiness'

/** The call controls in the dashboard's own colours, which follow its light and dark themes. */
const DASHBOARD_CALL_THEME: VoiceCallTheme = {
  accent: 'var(--primary)',
  accentForeground: 'var(--primary-foreground)',
  inputBackground: 'var(--background)',
  inputBorder: 'var(--input)',
  inputForeground: 'var(--foreground)',
  mutedForeground: 'var(--muted-foreground)',
}

/** How often, and how many times, the transcript is read again while a spoken turn still runs. */
const SPOKEN_TURN_POLL = { intervalMs: 750, attempts: 8 } as const

/**
 * Whether Talk shows: hidden while the agent's voice channel is off (or its readiness cannot be read),
 * shown disabled with the one line that names what voice still needs, or ready. The same readiness
 * as the website widget's calls switch, read again when it may have changed.
 */
type TalkReadiness = { kind: 'hidden' } | { kind: 'ready' } | { kind: 'not_ready'; hint: string }

function useTalkReadiness(agentId: string): TalkReadiness {
  const [readiness, setReadiness] = useState<TalkReadiness>({ kind: 'hidden' })
  useEffect(() => {
    let active = true
    const read = () => {
      agentsApi.getAgent(agentId).then((agent) => {
        if (!active) return
        const known = agent.voiceCallReadiness
        const vendorName = agent.voice.runtime ? providerDisplayName[agent.voice.runtime.vendor] : 'vendor'
        setReadiness(!agent.voice.enabled || !known
          ? { kind: 'hidden' }
          : known.ready ? { kind: 'ready' } : { kind: 'not_ready', hint: voiceCallReadinessHint(known.missing, vendorName) })
      }, () => undefined)
    }
    read()
    const stopReading = onVoiceCallReadinessChange(agentId, read)
    return () => {
      active = false
      stopReading()
    }
  }, [agentId])
  return readiness
}

/** Test Chat shows the call's turns from the test's own transcript, so no line sits between its messages. */
const noPrecedingMessages = (): readonly string[] => []

/** Talk to the open single test by voice. */
interface TestChatTalk {
  /** The test the composer sends to now; null before one is open. */
  executionId: string | null
  /** The test the next turn runs on: the open one, or a fresh one on the saved draft. Null when none could start. */
  prepareExecution: () => Promise<string | null>
  /** The test's transcript as recorded after a spoken turn, which carries the spoken marker. */
  onSpokenTurns: (detail: TestExecutionHistoryDetail) => void
}

/**
 * Test Chat's composer: the message box and Send, and Talk beside them when the agent's voice is set
 * up. A call runs through the same voice session and call controls as the website embed's Talk, with
 * Test Chat's own start, so its turns run on the test's revision. While it runs, the call bar stands
 * in for the composer, and the transcript is read again after each line said on the call.
 */
export function TestChatComposer({
  agentId,
  message,
  onMessageChange,
  onSubmit,
  canSend,
  sendLabel,
  isStarting,
  talk,
}: {
  agentId: string
  message: string
  onMessageChange: (value: string) => void
  onSubmit: (event: FormEvent) => void
  canSend: boolean
  sendLabel: string
  isStarting: boolean
  /** Absent where a test takes no spoken turn: a comparison would answer twice. */
  talk?: TestChatTalk
}) {
  const hintId = useId()
  const readiness = useTalkReadiness(agentId)
  const talkWanted = talk !== undefined && readiness.kind !== 'hidden'
  const talkShown = useCanAskForMicrophone(talkWanted)
  const talkRef = useRef(talk)
  useEffect(() => {
    talkRef.current = talk
  }, [talk])
  // The test the last call's start resolved to, cleared when Talk is pressed: until a call's own
  // start resolves, no earlier call's test can end it. `press` tells a stale start from the current one.
  const [callExecution, setCallExecution] = useState<string | null>(null)
  const pressRef = useRef(0)

  const refresh = useCallback((executionId: string) => {
    const read = (attemptsLeft: number) => {
      void agentRevisionsApi.getTestExecution(agentId, executionId).then(({ execution: detail }) => {
        talkRef.current?.onSpokenTurns(detail)
        if (attemptsLeft > 0 && detail.attempts.some((attempt) => attempt.state === 'running')) {
          window.setTimeout(() => read(attemptsLeft - 1), SPOKEN_TURN_POLL.intervalMs)
        }
      }, () => undefined)
    }
    read(SPOKEN_TURN_POLL.attempts)
  }, [agentId])

  const voice = useVoiceSession({
    calls: {
      startSession: async () => {
        const press = pressRef.current
        const executionId = await talkRef.current?.prepareExecution()
        if (!executionId) return { kind: 'refused' }
        const start = await startTestChatVoiceSession(agentId, executionId)
        if (start.kind === 'started' && pressRef.current === press) setCallExecution(executionId)
        return start
      },
    },
    precedingMessageIds: noPrecedingMessages,
    offered: talkShown,
  })
  const { stop: stopCall, isActive: callActive, talk: startCall } = voice
  const pressTalk = () => {
    pressRef.current += 1
    setCallExecution(null)
    startCall()
  }

  // Each line said on the call follows a turn the test records; the call's end settles the last one.
  const lineCount = voice.lines.length
  useEffect(() => {
    if (callExecution && (!callActive || lineCount > 0)) refresh(callExecution)
  }, [callActive, callExecution, lineCount, refresh])

  // A call belongs to its test: once its start has resolved, opening another test or a new chat ends it.
  const visibleExecutionId = talk?.executionId ?? null
  useEffect(() => {
    if (callActive && callExecution && visibleExecutionId !== callExecution) stopCall()
  }, [callActive, callExecution, stopCall, visibleExecutionId])

  const submitOnEnter = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    event.currentTarget.form?.requestSubmit()
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      {talkShown ? <VoiceCallNotice theme={DASHBOARD_CALL_THEME} copy={DEFAULT_WEBSITE_EMBED_COPY} state={voice.state} /> : null}
      {talkShown && callActive ? (
        <VoiceCallBar theme={DASHBOARD_CALL_THEME} copy={DEFAULT_WEBSITE_EMBED_COPY} state={voice.state} onStop={stopCall} recordingNotice={voice.recordingNotice} />
      ) : (
        <form onSubmit={onSubmit}>
          <div className="flex items-end gap-1 rounded-2xl border border-input bg-input/40 px-2 py-1.5 transition-colors focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-0">
            <Textarea
              value={message}
              onChange={(event) => onMessageChange(event.target.value)}
              onKeyDown={submitOnEnter}
              placeholder="Ask a question..."
              className="min-h-[36px] max-h-32 flex-1 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0"
              disabled={!canSend}
            />
            {talkShown ? (
              <VoiceTalkButton
                theme={DASHBOARD_CALL_THEME}
                copy={DEFAULT_WEBSITE_EMBED_COPY}
                onPress={pressTalk}
                disabled={readiness.kind !== 'ready' || !canSend}
                describedBy={readiness.kind === 'not_ready' ? hintId : undefined}
              />
            ) : null}
            <Button
              type="submit"
              size="icon"
              className="shrink-0 rounded-full"
              aria-label={sendLabel}
              title={sendLabel}
              disabled={!canSend || !message.trim()}
            >
              {isStarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              <span className="sr-only">{sendLabel}</span>
            </Button>
          </div>
        </form>
      )}
      {talkShown && readiness.kind === 'not_ready' ? (
        <p id={hintId} className="mt-1.5 px-2 text-xs text-muted-foreground">{readiness.hint}</p>
      ) : null}
    </div>
  )
}
