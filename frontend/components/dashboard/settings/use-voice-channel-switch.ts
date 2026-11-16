'use client'

import { useEffect, useRef, useState } from 'react'

import { agentVoiceConnectionApi } from '@/lib/api-agent-voice-connection'
import { getApiErrorMessage } from '@/lib/api-error'
import { llmProvidersApi, providerDisplayName, type VoiceVendorName } from '@/lib/api-llm-providers'
import type { AgentVoiceConnection } from '@/lib/api-types'
import {
  voiceConnectionFailureMessage,
  voiceVendorKeyProblemOfError,
  type VoiceVendorKeyProblem,
} from '@/lib/voice-connection-failures'
import { AGENT_VOICE_SAVED_EVENT } from '@/lib/voice-settings-form'

/** How a switch ended: `error` is null when the operator cancelled the key dialog. */
type VoiceChannelSwitchResult = { switched: true } | { switched: false; error: string | null }

type Answer =
  | { kind: 'switched'; connection: AgentVoiceConnection }
  | { kind: 'key'; problem: VoiceVendorKeyProblem }
  | { kind: 'failed'; message: string }

/** What the key dialog shows and does; render `VoiceVendorKeyDialog` with it. */
export interface VoiceVendorKeyDialogState {
  open: boolean
  /** Why the key is asked for; kept after closing, so the dialog reads the same while it closes. */
  problem: VoiceVendorKeyProblem
  /** Counts each time the key is asked for, so every ask starts with an empty field. */
  ask: number
  vendorName: string
  saving: boolean
  error: string | null
  onSave: (apiKey: string) => void
  onCancel: () => void
}

/**
 * Turns an agent's voice channel on or off. When turning it on needs the vendor's API key, it asks
 * for the key in place, stores it as the workspace's key, and switches again. The backend turns voice
 * on only with a key the vendor accepts, so a cancelled ask changes nothing. Every switch that went
 * through goes to `onSwitched` and tells the page that the agent's voice changed. `switchChannel`
 * resolves once the operator has saved a working key or cancelled, or the page unmounts; `pending`
 * holds the side being switched to until then.
 */
export function useVoiceChannelSwitch({
  agentId,
  vendor,
  onSwitched,
}: {
  agentId: string
  vendor: VoiceVendorName
  onSwitched?: (connection: AgentVoiceConnection) => void
}) {
  const vendorName = providerDisplayName[vendor]
  const [pending, setPending] = useState<boolean | null>(null)
  const [keyRequest, setKeyRequest] = useState<{ open: boolean; problem: VoiceVendorKeyProblem; ask: number }>({ open: false, problem: 'missing', ask: 0 })
  const [keySaving, setKeySaving] = useState(false)
  const [keyError, setKeyError] = useState<string | null>(null)
  const settleRef = useRef<((result: VoiceChannelSwitchResult) => void) | null>(null)

  // A page that unmounts with the key dialog open ends the switch as cancelled.
  useEffect(() => () => {
    settleRef.current?.({ switched: false, error: null })
    settleRef.current = null
  }, [])

  const askForKey = (problem: VoiceVendorKeyProblem) => setKeyRequest((current) => ({ open: true, problem, ask: current.ask + 1 }))

  const attempt = async (enabled: boolean): Promise<Answer> => {
    let connection: AgentVoiceConnection
    try {
      connection = await agentVoiceConnectionApi.switchChannel(agentId, enabled)
    } catch (caught) {
      const problem = enabled ? voiceVendorKeyProblemOfError(caught) : null
      if (problem) return { kind: 'key', problem }
      const fallback = enabled ? 'Failed to turn voice on.' : 'Failed to turn voice off.'
      return { kind: 'failed', message: voiceConnectionFailureMessage(caught, vendorName, fallback) }
    }
    onSwitched?.(connection)
    window.dispatchEvent(new CustomEvent(AGENT_VOICE_SAVED_EVENT, { detail: { agentId } }))
    return { kind: 'switched', connection }
  }

  const settle = (result: VoiceChannelSwitchResult) => {
    setPending(null)
    setKeyRequest((current) => ({ ...current, open: false }))
    setKeyError(null)
    const resolve = settleRef.current
    settleRef.current = null
    resolve?.(result)
  }

  const switchChannel = async (enabled: boolean): Promise<VoiceChannelSwitchResult> => {
    setPending(enabled)
    const answer = await attempt(enabled)
    if (answer.kind === 'failed') {
      setPending(null)
      return { switched: false, error: answer.message }
    }
    if (answer.kind === 'switched') {
      setPending(null)
      return { switched: true }
    }
    askForKey(answer.problem)
    return new Promise<VoiceChannelSwitchResult>((resolve) => {
      settleRef.current?.({ switched: false, error: null })
      settleRef.current = resolve
    })
  }

  const saveKey = async (apiKey: string) => {
    setKeySaving(true)
    setKeyError(null)
    const stored = await llmProvidersApi.setCredential(vendor, { apiKey }).then(
      () => true,
      (caught: unknown) => {
        setKeyError(getApiErrorMessage(caught, `Failed to save the ${vendorName} key.`))
        return false
      },
    )
    const answer = stored ? await attempt(true) : null
    setKeySaving(false)
    if (!answer) return
    // The key just stored fails as well: the dialog says why, and the operator may enter another.
    if (answer.kind === 'key') {
      askForKey(answer.problem)
      return
    }
    settle(answer.kind === 'switched' ? { switched: true } : { switched: false, error: answer.message })
  }

  const keyDialog: VoiceVendorKeyDialogState = {
    ...keyRequest,
    vendorName,
    saving: keySaving,
    error: keyError,
    onSave: (apiKey) => void saveKey(apiKey),
    onCancel: () => {
      if (!keySaving) settle({ switched: false, error: null })
    },
  }

  return { switchChannel, pending, keyDialog }
}
