'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, Loader2, RefreshCw } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { CopyValueField } from '@/components/ui/copy-value-field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { getApiErrorCode, getApiErrorMessage } from '@/lib/api-error'
import { emailChannelApi, type EmailDnsRecord, type EmailDomain } from '@/lib/api-email-channel'

const REFUSAL_COPY: Readonly<Record<string, string>> = {
  domain_claimed_elsewhere: 'This domain is claimed by another workspace.',
  email_channel_not_configured: 'Email isn’t enabled on this server.',
  engagement_mode_unavailable: 'That mode isn’t available on this server.',
}

/** The operator-facing message for an email channel request that failed. */
export const emailChannelErrorMessage = (error: unknown, fallback: string): string => {
  const code = getApiErrorCode(error)
  return (code ? REFUSAL_COPY[code] : undefined) ?? getApiErrorMessage(error, fallback)
}

const PURPOSE_LABELS: Record<EmailDnsRecord['purpose'], string> = {
  dkim: 'DKIM',
  spf: 'SPF',
  return_path: 'Return path',
  receiving_mx: 'Receiving MX',
  dmarc: 'DMARC',
}

const RECORD_STATUS_LABELS: Record<EmailDnsRecord['status'], string> = {
  pending: 'Pending',
  verified: 'Verified',
  failed: 'Failed',
  advisory: 'Recommended',
}

const SENDING_STATUS_LABELS: Record<EmailDomain['sending']['status'], string> = {
  pending: 'Pending',
  verified: 'Verified',
  failed: 'Failed',
}

const RECEIVING_STATUS_LABELS: Record<Exclude<EmailDomain['receiving']['status'], 'not_requested'>, string> = {
  pending: 'Pending',
  verified: 'Verified',
  failed: 'Failed',
}

/** Sending needs every record except the advisory ones and the receiving MX. */
const requiredSendingRecords = (domain: EmailDomain) =>
  domain.records.filter((record) => record.status !== 'advisory' && record.purpose !== 'receiving_mx')

const verifiedSummary = (domain: EmailDomain) => {
  const required = requiredSendingRecords(domain)
  const verified = required.filter((record) => record.status === 'verified').length
  return `${verified} of ${required.length} required records verified.`
}

type EmailDomainRecordsProps = {
  workspaceId: string
  domains: EmailDomain[]
  onDomainChanged: (domain: EmailDomain) => void
  announce: (message: string) => void
}

/** The workspace's sending domains: DNS records to copy, per-record status, and direct receiving. */
export function EmailDomainRecords({ workspaceId, domains, onDomainChanged, announce }: EmailDomainRecordsProps) {
  const [domainDraft, setDomainDraft] = useState('')
  const [isAdding, setIsAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const addDomain = async () => {
    const domain = domainDraft.trim()
    if (!domain || isAdding) return
    setIsAdding(true)
    setAddError(null)
    try {
      onDomainChanged(await emailChannelApi.addDomain(workspaceId, domain))
      setDomainDraft('')
      announce('Domain added.')
    } catch (error) {
      setAddError(emailChannelErrorMessage(error, 'Failed to add the domain.'))
    } finally {
      setIsAdding(false)
    }
  }

  return (
    <div className="space-y-3">
      <h4 className="text-sm font-medium text-foreground">Sending domains</h4>
      {domains.length === 0 ? (
        <p className="text-sm text-muted-foreground">Adding a mailbox adds its domain here.</p>
      ) : (
        domains.map((domain) => (
          <EmailDomainPanel
            key={domain.id}
            workspaceId={workspaceId}
            domain={domain}
            onDomainChanged={onDomainChanged}
            announce={announce}
          />
        ))
      )}
      <form
        className="max-w-md space-y-2"
        onSubmit={(event) => {
          event.preventDefault()
          void addDomain()
        }}
      >
        <Label htmlFor="email-domain-draft" className="text-foreground">Domain</Label>
        <div className="flex flex-wrap gap-2">
          <Input
            id="email-domain-draft"
            value={domainDraft}
            onChange={(event) => setDomainDraft(event.target.value)}
            placeholder="mail.yourcompany.com"
            className="min-w-0 flex-1"
          />
          <Button type="submit" variant="outline" disabled={!domainDraft.trim()} aria-busy={isAdding || undefined}>
            {isAdding ? <Loader2 className="animate-spin" aria-hidden /> : null}
            Add domain
          </Button>
        </div>
        {addError ? <p className="text-sm text-destructive" role="alert">{addError}</p> : null}
      </form>
    </div>
  )
}

type EmailDomainPanelProps = {
  workspaceId: string
  domain: EmailDomain
  onDomainChanged: (domain: EmailDomain) => void
  announce: (message: string) => void
}

function EmailDomainPanel({ workspaceId, domain, onDomainChanged, announce }: EmailDomainPanelProps) {
  const headingId = useId()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const focusHeadingRef = useRef(false)
  const [busyAction, setBusyAction] = useState<'verify' | 'receiving' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [receivingOpen, setReceivingOpen] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  const required = requiredSendingRecords(domain)
  const isPartial = domain.sending.status !== 'verified' && required.some((record) => record.status === 'verified')

  // Enabling direct receiving replaces its form, so focus moves to the domain once that renders.
  useEffect(() => {
    if (!focusHeadingRef.current) return
    focusHeadingRef.current = false
    headingRef.current?.focus()
  })

  const verify = async () => {
    if (busyAction) return
    setBusyAction('verify')
    setError(null)
    try {
      const refreshed = await emailChannelApi.verifyDomain(workspaceId, domain.id)
      onDomainChanged(refreshed)
      announce(refreshed.sending.status === 'verified' ? 'DNS checked. Sending verified.' : `DNS checked. ${verifiedSummary(refreshed)}`)
    } catch (caught) {
      setError(emailChannelErrorMessage(caught, 'Failed to check DNS.'))
    } finally {
      setBusyAction(null)
    }
  }

  const enableDirectReceiving = async () => {
    if (busyAction || confirmation !== domain.domain) return
    setBusyAction('receiving')
    setError(null)
    try {
      onDomainChanged(await emailChannelApi.enableDirectReceiving(workspaceId, domain.id, confirmation))
      setConfirmation('')
      focusHeadingRef.current = true
      announce('Direct receiving requested.')
    } catch (caught) {
      setError(emailChannelErrorMessage(caught, 'Failed to enable direct receiving.'))
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <section aria-labelledby={headingId} className="space-y-3 rounded-xl border border-border bg-background p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h5 id={headingId} ref={headingRef} tabIndex={-1} className="text-sm font-medium text-foreground outline-none">
            {domain.domain}
          </h5>
          <Badge variant={domain.sending.status === 'verified' ? 'outline' : 'secondary'}>
            Sending: {SENDING_STATUS_LABELS[domain.sending.status]}
          </Badge>
          {domain.receiving.status !== 'not_requested' ? (
            <Badge variant={domain.receiving.status === 'verified' ? 'outline' : 'secondary'}>
              Receiving: {RECEIVING_STATUS_LABELS[domain.receiving.status]}
            </Badge>
          ) : null}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void verify()} aria-busy={busyAction === 'verify' || undefined}>
          {busyAction === 'verify' ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
          Check DNS
        </Button>
      </div>

      {isPartial ? <p className="text-xs text-muted-foreground">{verifiedSummary(domain)}</p> : null}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[36rem] text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="py-1 pr-3 font-medium">Record</th>
              <th scope="col" className="py-1 pr-3 font-medium">Name</th>
              <th scope="col" className="py-1 pr-3 font-medium">Value</th>
              <th scope="col" className="py-1 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {domain.records.map((record) => {
              const label = PURPOSE_LABELS[record.purpose]
              return (
                <tr key={`${record.purpose}:${record.type}:${record.name}`} className="align-top">
                  <td className="py-2 pr-3 whitespace-nowrap text-foreground">
                    {label} <span className="text-muted-foreground">{record.type}</span>
                    {record.priority !== undefined ? <span className="text-muted-foreground"> {record.priority}</span> : null}
                  </td>
                  <td className="py-2 pr-3">
                    <CopyValueField value={record.name} ariaLabel={`Copy ${label} name`} compact truncate />
                  </td>
                  <td className="py-2 pr-3">
                    <CopyValueField value={record.value} ariaLabel={`Copy ${label} value`} compact truncate />
                  </td>
                  <td className="py-2">
                    <Badge variant={record.status === 'verified' ? 'outline' : 'secondary'}>{RECORD_STATUS_LABELS[record.status]}</Badge>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <Collapsible open={receivingOpen} onOpenChange={setReceivingOpen}>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="gap-1 px-2">
            Direct receiving
            <ChevronDown className="h-4 w-4" aria-hidden />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-2 pt-2">
          <p className="text-xs text-muted-foreground">
            All mail for {domain.domain} will route to Radioso.
          </p>
          {domain.receiving.status === 'not_requested' ? (
            <form
              className="max-w-md space-y-2"
              onSubmit={(event) => {
                event.preventDefault()
                void enableDirectReceiving()
              }}
            >
              <Label htmlFor={`${headingId}-confirm`} className="text-foreground">Type {domain.domain} to confirm</Label>
              <div className="flex flex-wrap gap-2">
                <Input
                  id={`${headingId}-confirm`}
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  autoComplete="off"
                  className="min-w-0 flex-1"
                />
                <Button
                  type="submit"
                  variant="outline"
                  disabled={confirmation !== domain.domain}
                  aria-busy={busyAction === 'receiving' || undefined}
                >
                  {busyAction === 'receiving' ? <Loader2 className="animate-spin" aria-hidden /> : null}
                  Enable direct receiving
                </Button>
              </div>
            </form>
          ) : (
            <p className="text-xs text-muted-foreground">Add the receiving MX record above. Its status is tracked separately.</p>
          )}
        </CollapsibleContent>
      </Collapsible>

      {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
    </section>
  )
}
