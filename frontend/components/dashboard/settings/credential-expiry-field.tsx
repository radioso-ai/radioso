'use client'

import { defaultExpiryDate, expiryInputToIso, nativeSelectClassName } from '@/components/dashboard/settings/api-access-dialogs'
import { Input } from '@/components/ui/input'

/** The date survives switching to "Never" and back, so a toggle never loses what was typed. */
interface CredentialExpiryDraft {
  mode: 'never' | 'date'
  date: string
}

export const initialCredentialExpiry = (): CredentialExpiryDraft => ({ mode: 'never', date: defaultExpiryDate(90) })

type CredentialExpiryRequest = { valid: true; expiresAt: string | null } | { valid: false }

/**
 * The issue request's expiry. `expiresAt: null` asks for a credential that never expires, so an
 * empty or already-started date is refused here rather than collapsing into that same `null`.
 */
export const credentialExpiryRequest = (draft: CredentialExpiryDraft, now = new Date()): CredentialExpiryRequest => {
  if (draft.mode === 'never') return { valid: true, expiresAt: null }
  const expiresAt = expiryInputToIso(draft.date)
  return expiresAt && Date.parse(expiresAt) > now.getTime() ? { valid: true, expiresAt } : { valid: false }
}

export function CredentialExpiryField({
  id,
  value,
  onChange,
}: {
  id: string
  value: CredentialExpiryDraft
  onChange: (next: CredentialExpiryDraft) => void
}) {
  return (
    <div className="space-y-2">
      <select
        id={id}
        className={nativeSelectClassName}
        value={value.mode}
        onChange={(event) => onChange({ ...value, mode: event.target.value === 'date' ? 'date' : 'never' })}
      >
        <option value="never">Never</option>
        <option value="date">On a date</option>
      </select>
      {value.mode === 'date' ? (
        <Input
          type="date"
          aria-label="Expiry date"
          min={defaultExpiryDate(1)}
          value={value.date}
          onChange={(event) => onChange({ ...value, date: event.target.value })}
        />
      ) : null}
    </div>
  )
}
