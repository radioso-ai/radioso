/**
 * Transient handoff for opening the canonical document composer from an Audience
 * Pulse recommendation. Lives in `sessionStorage` — never in the URL — so the
 * recommendation title and questions do not leak into browser history, sharing,
 * or analytics. Scoped by account + workspace so a mismatched read clears itself.
 */

export interface AudiencePulseDraftSeed {
  title: string
  questions: string[]
}

interface StoredSeed extends AudiencePulseDraftSeed {
  accountId: string
  workspaceId: string
  writtenAt: string
}

export const AUDIENCE_PULSE_DRAFT_SEED_KEY = 'radioso.audiencePulseDraftSeed'

function safeSessionStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

export function writeAudiencePulseDraftSeed(scope: {
  accountId: string
  workspaceId: string
  seed: AudiencePulseDraftSeed
}): void {
  const storage = safeSessionStorage()
  if (!storage) return

  const payload: StoredSeed = {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    title: scope.seed.title,
    questions: [...scope.seed.questions],
    writtenAt: new Date().toISOString(),
  }
  try {
    storage.setItem(AUDIENCE_PULSE_DRAFT_SEED_KEY, JSON.stringify(payload))
  } catch {
    // Storage is best-effort; a full quota should not break the click.
  }
}

export function clearAudiencePulseDraftSeed(): void {
  const storage = safeSessionStorage()
  if (!storage) return
  try {
    storage.removeItem(AUDIENCE_PULSE_DRAFT_SEED_KEY)
  } catch {
    // ignore
  }
}

function parseStoredSeed(raw: string | null): StoredSeed | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed
      && typeof parsed === 'object'
      && typeof (parsed as StoredSeed).accountId === 'string'
      && typeof (parsed as StoredSeed).workspaceId === 'string'
      && typeof (parsed as StoredSeed).title === 'string'
      && Array.isArray((parsed as StoredSeed).questions)
      && (parsed as StoredSeed).questions.every((question) => typeof question === 'string')
    ) {
      return parsed as StoredSeed
    }
    return null
  } catch {
    return null
  }
}

/**
 * Read a seed that matches the active account and workspace, deleting the stored
 * entry regardless of whether it matched. This makes handoff single-use and
 * guarantees a mismatched entry cannot leak across workspaces.
 */
export function consumeAudiencePulseDraftSeed(scope: {
  accountId: string
  workspaceId: string
}): AudiencePulseDraftSeed | null {
  const storage = safeSessionStorage()
  if (!storage) return null

  let raw: string | null = null
  try {
    raw = storage.getItem(AUDIENCE_PULSE_DRAFT_SEED_KEY)
  } catch {
    return null
  }

  const stored = parseStoredSeed(raw)
  // Whatever we found, remove it: the caller either consumes the match here
  // (single-use handoff) or discards a mismatch that must not survive.
  if (raw !== null) {
    try {
      storage.removeItem(AUDIENCE_PULSE_DRAFT_SEED_KEY)
    } catch {
      // ignore
    }
  }

  if (!stored) return null
  if (stored.accountId !== scope.accountId || stored.workspaceId !== scope.workspaceId) {
    return null
  }
  return { title: stored.title, questions: stored.questions }
}

/**
 * Render an Audience Pulse recommendation's questions as a Markdown bullet list
 * so the composer's `content` field is populated with a concrete, editable seed
 * the operator can rework immediately.
 */
export function formatDraftQuestionsAsMarkdown(questions: string[]): string {
  if (questions.length === 0) return ''
  return questions.map((question) => `- ${question.trim()}`).filter((line) => line !== '- ').join('\n')
}
