import type { ApiConnection, ApiConnectionAuthScheme, ApiConnectionInput } from '@/lib/api-connections'

export const API_AUTH_SCHEMES: ReadonlyArray<{ value: ApiConnectionAuthScheme; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'bearer', label: 'Bearer token' },
  { value: 'header', label: 'Header' },
  { value: 'basic', label: 'Basic' },
]

export type ApiConnectionHeaderDraft = { id: string; name: string; value: string }

export type ApiConnectionDraft = {
  name: string
  baseUrl: string
  authScheme: ApiConnectionAuthScheme
  authHeaderName: string
  // Write-only: an empty value on an existing connection keeps the stored credential.
  credential: string
  headers: ApiConnectionHeaderDraft[]
}

let headerCounter = 0
export const emptyHeaderDraft = (): ApiConnectionHeaderDraft => ({ id: `header-${headerCounter += 1}`, name: '', value: '' })

export const emptyConnectionDraft = (): ApiConnectionDraft => ({
  name: '', baseUrl: '', authScheme: 'none', authHeaderName: '', credential: '', headers: [],
})

export const connectionDraftFrom = (connection: ApiConnection): ApiConnectionDraft => ({
  name: connection.name,
  baseUrl: connection.baseUrl,
  authScheme: connection.authScheme,
  authHeaderName: connection.authHeaderName ?? '',
  credential: '',
  headers: Object.entries(connection.defaultHeaders).map(([name, value]) => ({ ...emptyHeaderDraft(), name, value })),
})

const originOf = (url: string): string => {
  try {
    return new URL(url.trim()).origin
  } catch {
    return url.trim()
  }
}

/**
 * Whether the credential must be typed now: a new connection, a scheme that had none stored, or
 * a change of origin, scheme or header name, which would otherwise send the stored credential
 * somewhere or somehow the operator never approved it for.
 */
export const needsCredentialNow = (draft: ApiConnectionDraft, existing: ApiConnection | null): boolean => {
  if (draft.authScheme === 'none') return false
  if (!existing || existing.credentialMask === null || existing.authScheme === 'none') return true
  return originOf(draft.baseUrl) !== originOf(existing.baseUrl)
    || draft.authScheme !== existing.authScheme
    || (draft.authScheme === 'header' && draft.authHeaderName.trim() !== (existing.authHeaderName ?? ''))
}

export const canSaveConnection = (draft: ApiConnectionDraft, existing: ApiConnection | null): boolean => {
  if (!draft.name.trim() || !draft.baseUrl.trim()) return false
  if (draft.authScheme === 'header' && !draft.authHeaderName.trim()) return false
  if (needsCredentialNow(draft, existing) && !draft.credential) return false
  return true
}

/** The request body: the credential only when typed, the header name only for the header scheme. */
export const buildConnectionInput = (draft: ApiConnectionDraft): ApiConnectionInput => ({
  name: draft.name.trim(),
  baseUrl: draft.baseUrl.trim(),
  authScheme: draft.authScheme,
  authHeaderName: draft.authScheme === 'header' ? draft.authHeaderName.trim() : null,
  ...(draft.authScheme !== 'none' && draft.credential ? { credential: draft.credential } : {}),
  defaultHeaders: Object.fromEntries(
    draft.headers
      .filter((header) => header.name.trim())
      .map((header) => [header.name.trim(), header.value]),
  ),
})

/** A create body leaves a null header name out: the backend takes the field only for the header scheme. */
export const buildCreateConnectionInput = (draft: ApiConnectionDraft): ApiConnectionInput => {
  const { authHeaderName, ...input } = buildConnectionInput(draft)
  return authHeaderName ? { ...input, authHeaderName } : input
}
