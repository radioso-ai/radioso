'use client'

import { Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { ApiConnection, ApiConnectionAuthScheme } from '@/lib/api-connections'
import {
  API_AUTH_SCHEMES,
  emptyHeaderDraft,
  needsCredentialNow,
  type ApiConnectionDraft,
  type ApiConnectionHeaderDraft,
} from './api-connection-form-model'

const credentialLabel: Record<ApiConnectionAuthScheme, string> = {
  none: 'Credential',
  bearer: 'Token',
  header: 'Header value',
  basic: 'Username:password',
}

export function ApiConnectionForm({ draft, existing, onChange }: {
  draft: ApiConnectionDraft
  existing: ApiConnection | null
  onChange: (draft: ApiConnectionDraft) => void
}) {
  const patch = (next: Partial<ApiConnectionDraft>) => onChange({ ...draft, ...next })
  const updateHeader = (id: string, next: Partial<ApiConnectionHeaderDraft>) =>
    patch({ headers: draft.headers.map((header) => (header.id === id ? { ...header, ...next } : header)) })
  const keepsCredential = Boolean(existing?.credentialMask) && !needsCredentialNow(draft, existing)

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="api-connection-name">Name</Label>
        <Input id="api-connection-name" value={draft.name} onChange={(event) => patch({ name: event.target.value })} placeholder="shop-api" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="api-connection-url">Base URL</Label>
        <Input
          id="api-connection-url"
          type="url"
          value={draft.baseUrl}
          onChange={(event) => patch({ baseUrl: event.target.value })}
          placeholder="https://api.shop.example/v2"
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="api-connection-auth">Authentication</Label>
          <Select value={draft.authScheme} onValueChange={(value) => patch({ authScheme: value as ApiConnectionAuthScheme, credential: '' })}>
            <SelectTrigger id="api-connection-auth"><SelectValue /></SelectTrigger>
            <SelectContent>
              {API_AUTH_SCHEMES.map((scheme) => <SelectItem key={scheme.value} value={scheme.value}>{scheme.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {draft.authScheme === 'header' ? (
          <div className="space-y-2">
            <Label htmlFor="api-connection-header-name">Header name</Label>
            <Input id="api-connection-header-name" value={draft.authHeaderName} onChange={(event) => patch({ authHeaderName: event.target.value })} placeholder="X-Api-Key" />
          </div>
        ) : null}
      </div>
      {draft.authScheme !== 'none' ? (
        <div className="space-y-2">
          <Label htmlFor="api-connection-credential">{credentialLabel[draft.authScheme]}</Label>
          <Input
            id="api-connection-credential"
            type="password"
            autoComplete="new-password"
            value={draft.credential}
            onChange={(event) => patch({ credential: event.target.value })}
            placeholder={keepsCredential ? (existing?.credentialMask ?? '') : ''}
          />
          {existing && !keepsCredential && existing.credentialMask ? (
            <p className="text-xs text-destructive">Enter the credential again for this change.</p>
          ) : null}
        </div>
      ) : null}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>Default headers</Label>
          <Button type="button" variant="ghost" size="sm" onClick={() => patch({ headers: [...draft.headers, emptyHeaderDraft()] })}>
            <Plus className="h-4 w-4" />
            Header
          </Button>
        </div>
        {draft.headers.map((header, index) => (
          <div key={header.id} className="grid grid-cols-[1fr_1fr_auto] gap-2">
            <Input aria-label={`Header ${index + 1} name`} value={header.name} onChange={(event) => updateHeader(header.id, { name: event.target.value })} placeholder="Accept-Language" />
            <Input aria-label={`Header ${index + 1} value`} value={header.value} onChange={(event) => updateHeader(header.id, { value: event.target.value })} />
            <Button type="button" variant="ghost" size="icon" aria-label={`Remove header ${index + 1}`} onClick={() => patch({ headers: draft.headers.filter((candidate) => candidate.id !== header.id) })}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}
