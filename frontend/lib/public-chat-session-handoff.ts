import {
  storeAnonymousSessionId,
  storePublicSessionToken,
} from '@/lib/api'

const SESSION_HANDOFF_HASH_PARAM = 'radiosoSession'

export interface PublicChatSessionHandoff {
  publicSessionId: string
  publicSessionToken: string
  expiresAt: string
}

const encodeBase64Url = (value: string) => {
  if (typeof window !== 'undefined' && typeof window.btoa === 'function') {
    return window.btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
  }

  return globalThis.btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

const decodeBase64Url = (value: string) => {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = `${normalized}${'='.repeat((4 - (normalized.length % 4)) % 4)}`

  if (typeof window !== 'undefined' && typeof window.atob === 'function') {
    return window.atob(padded)
  }

  return globalThis.atob(padded)
}

const parseHandoff = (value: string | null): PublicChatSessionHandoff | null => {
  if (!value) {
    return null
  }

  try {
    const parsed = JSON.parse(decodeBase64Url(value)) as Partial<PublicChatSessionHandoff>
    if (
      typeof parsed.publicSessionId !== 'string' ||
      typeof parsed.publicSessionToken !== 'string' ||
      typeof parsed.expiresAt !== 'string' ||
      Date.parse(parsed.expiresAt) <= Date.now()
    ) {
      return null
    }

    return {
      publicSessionId: parsed.publicSessionId,
      publicSessionToken: parsed.publicSessionToken,
      expiresAt: parsed.expiresAt,
    }
  } catch {
    return null
  }
}

export const buildPublicChatSessionHandoffHash = (handoff: PublicChatSessionHandoff) => {
  const params = new URLSearchParams()
  params.set(SESSION_HANDOFF_HASH_PARAM, encodeBase64Url(JSON.stringify(handoff)))
  return params.toString()
}

export const readPublicChatSessionHandoffHash = (hash: string) => {
  const normalizedHash = hash.startsWith('#') ? hash.slice(1) : hash
  return parseHandoff(new URLSearchParams(normalizedHash).get(SESSION_HANDOFF_HASH_PARAM))
}

export const consumePublicChatSessionHandoffHash = (token: string, hash?: string) => {
  if (typeof window === 'undefined') {
    return false
  }

  const currentHash = hash ?? window.location.hash
  const normalizedHash = currentHash.startsWith('#') ? currentHash.slice(1) : currentHash
  const params = new URLSearchParams(normalizedHash)
  const handoff = parseHandoff(params.get(SESSION_HANDOFF_HASH_PARAM))
  if (!handoff) {
    return false
  }

  storePublicSessionToken(token, handoff.publicSessionToken, handoff.expiresAt)
  storeAnonymousSessionId(token, handoff.publicSessionId)

  params.delete(SESSION_HANDOFF_HASH_PARAM)
  const nextHash = params.toString()
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${window.location.search}${nextHash ? `#${nextHash}` : ''}`,
  )

  return true
}
