/**
 * A single-use handoff from an Audience Pulse evidence card to the canonical
 * Activity drawer. Conversation and message identifiers stay out of URLs so
 * they cannot be copied into browser history, referrers, or analytics.
 */

export interface AudiencePulseEvidenceHandoff {
  conversationId: string
  messageId: string
}

interface StoredEvidenceHandoff extends AudiencePulseEvidenceHandoff {
  accountId: string
  workspaceId: string
  writtenAt: string
}

export const AUDIENCE_PULSE_EVIDENCE_HANDOFF_KEY = 'radioso.audiencePulseEvidenceHandoff'

function safeSessionStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function parseStoredEvidenceHandoff(raw: string | null): StoredEvidenceHandoff | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed
      && typeof parsed === 'object'
      && typeof (parsed as StoredEvidenceHandoff).accountId === 'string'
      && typeof (parsed as StoredEvidenceHandoff).workspaceId === 'string'
      && typeof (parsed as StoredEvidenceHandoff).conversationId === 'string'
      && typeof (parsed as StoredEvidenceHandoff).messageId === 'string'
    ) {
      return parsed as StoredEvidenceHandoff
    }
    return null
  } catch {
    return null
  }
}

export function writeAudiencePulseEvidenceHandoff(scope: {
  accountId: string
  workspaceId: string
  evidence: AudiencePulseEvidenceHandoff
}): void {
  const storage = safeSessionStorage()
  if (!storage) return

  const payload: StoredEvidenceHandoff = {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    conversationId: scope.evidence.conversationId,
    messageId: scope.evidence.messageId,
    writtenAt: new Date().toISOString(),
  }
  try {
    storage.setItem(AUDIENCE_PULSE_EVIDENCE_HANDOFF_KEY, JSON.stringify(payload))
  } catch {
    // Storage is best-effort; the normal Activity route remains usable.
  }
}

export function clearAudiencePulseEvidenceHandoff(): void {
  const storage = safeSessionStorage()
  if (!storage) return
  try {
    storage.removeItem(AUDIENCE_PULSE_EVIDENCE_HANDOFF_KEY)
  } catch {
    // ignore
  }
}

/**
 * Consume and clear the handoff even when it is malformed or scoped to another
 * account/workspace. This keeps the selection one-shot and prevents leakage
 * across workspace switches.
 */
export function consumeAudiencePulseEvidenceHandoff(scope: {
  accountId: string
  workspaceId: string
}): AudiencePulseEvidenceHandoff | null {
  const storage = safeSessionStorage()
  if (!storage) return null

  let raw: string | null = null
  try {
    raw = storage.getItem(AUDIENCE_PULSE_EVIDENCE_HANDOFF_KEY)
  } catch {
    return null
  }

  const stored = parseStoredEvidenceHandoff(raw)
  if (raw !== null) {
    try {
      storage.removeItem(AUDIENCE_PULSE_EVIDENCE_HANDOFF_KEY)
    } catch {
      // ignore
    }
  }

  if (!stored) return null
  if (stored.accountId !== scope.accountId || stored.workspaceId !== scope.workspaceId) {
    return null
  }
  return { conversationId: stored.conversationId, messageId: stored.messageId }
}
