'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { CheckCircle2, Loader2, Mail, MailCheck } from 'lucide-react'

import { EmailDomainRecords, emailChannelErrorMessage } from '@/components/dashboard/settings/email-domain-records'
import { EmailMailboxEvents } from '@/components/dashboard/settings/email-mailbox-events'
import { EmailMailboxMode, MODE_LABELS } from '@/components/dashboard/settings/email-mailbox-mode'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CopyValueField } from '@/components/ui/copy-value-field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { resolveEmailChannelStatus, type AgentChannelCatalogStatus } from '@/lib/agent-channel-catalog'
import { getApiErrorStatus } from '@/lib/api-error'
import {
  emailChannelApi,
  type EmailChannelOverview,
  type EmailDomain,
  type EmailEngagementMode,
  type EmailMailbox,
} from '@/lib/api-email-channel'
import {
  advanceSetupCheck,
  initialSetupCheckState,
  SETUP_CHECK_POLL_MS,
  setupCheckNextRequest,
  type SetupCheckState,
} from '@/lib/email-setup-check-state'
import { relativeTimestamp } from '@/lib/relative-time'

type EmailChannelCardProps = {
  workspaceId: string | null | undefined
  agentId: string | null | undefined
}

type CardLoad =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'error'; message: string }
  | { status: 'ready'; overview: EmailChannelOverview }

const STATUS_BADGES: Record<AgentChannelCatalogStatus | 'off', string> = {
  active: 'On',
  available: 'Not set up',
  attention: 'Needs attention',
  off: 'Off',
}

const SENDING_LABELS: Record<EmailMailbox['sending']['state'], string> = {
  ok: 'OK',
  not_verified: 'Not verified',
  domain_removed: 'Domain removed',
}

const receivingLabel = (receiving: EmailMailbox['receiving']) => {
  if (receiving.state === 'waiting_for_first_message') return 'Waiting for first message'
  const last = receiving.lastReceivedAt ? ` · last message ${relativeTimestamp(receiving.lastReceivedAt)}` : ''
  return receiving.state === 'silent' ? `Silent${last}` : `OK${last}`
}

const replaceById = <T extends { id: string }>(items: T[], next: T) =>
  items.some((item) => item.id === next.id) ? items.map((item) => (item.id === next.id ? next : item)) : [...items, next]

/**
 * The email channel for one agent: its mailboxes with relay address, forwarding
 * steps, mode, setup check and event log, and the workspace's sending domains.
 * Modes come from what the server supports, never from a list kept here.
 */
export function EmailChannelCard({ workspaceId, agentId }: EmailChannelCardProps) {
  const [load, setLoad] = useState<CardLoad>({ status: 'loading' })
  const [announcement, setAnnouncement] = useState('')
  const [addressDraft, setAddressDraft] = useState('')
  const [displayNameDraft, setDisplayNameDraft] = useState('')
  const [modeDraft, setModeDraft] = useState<EmailEngagementMode | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const mailboxHeadings = useRef(new Map<string, HTMLHeadingElement>())
  const focusMailboxRef = useRef<string | null>(null)

  const announce = useCallback((message: string) => setAnnouncement(message), [])

  const loadOverview = useCallback(async ({ quiet }: { quiet: boolean }) => {
    if (!workspaceId) return
    if (!quiet) setLoad({ status: 'loading' })
    try {
      const overview = await emailChannelApi.getOverview(workspaceId)
      setLoad(overview.configured ? { status: 'ready', overview } : { status: 'unavailable' })
    } catch (error) {
      // The server registers no email routes at all when no provider is configured.
      if (getApiErrorStatus(error) === 404) setLoad({ status: 'unavailable' })
      else if (!quiet) setLoad({ status: 'error', message: emailChannelErrorMessage(error, 'Failed to load email.') })
    }
  }, [workspaceId])

  useEffect(() => {
    queueMicrotask(() => {
      void loadOverview({ quiet: false })
    })
  }, [loadOverview])

  // A new mailbox's heading takes focus once it renders, so the add form's reset never drops focus.
  useEffect(() => {
    const mailboxId = focusMailboxRef.current
    if (!mailboxId) return
    const heading = mailboxHeadings.current.get(mailboxId)
    if (!heading) return
    focusMailboxRef.current = null
    heading.focus()
  })

  const updateOverview = useCallback((update: (overview: EmailChannelOverview) => EmailChannelOverview) => {
    setLoad((current) => (current.status === 'ready' ? { ...current, overview: update(current.overview) } : current))
  }, [])

  const handleMailboxChanged = useCallback((mailbox: EmailMailbox) => {
    updateOverview((overview) => ({ ...overview, mailboxes: replaceById(overview.mailboxes, mailbox) }))
  }, [updateOverview])

  // A domain change moves its mailboxes' sending state, which only the overview carries.
  const handleDomainChanged = useCallback((domain: EmailDomain) => {
    updateOverview((overview) => ({ ...overview, domains: replaceById(overview.domains, domain) }))
    void loadOverview({ quiet: true })
  }, [loadOverview, updateOverview])

  const overview = load.status === 'ready' ? load.overview : null
  const agentMailboxes = overview?.mailboxes.filter((mailbox) => mailbox.agentId === agentId) ?? []
  const supportedModes = overview?.supportedModes ?? []
  const defaultMode = overview?.defaultMode ?? null
  const selectedMode = [modeDraft, defaultMode, supportedModes[0]]
    .find((mode): mode is EmailEngagementMode => mode != null && supportedModes.includes(mode)) ?? null
  const modeOptions: SegmentedControlOption<EmailEngagementMode>[] = supportedModes.map((mode) => ({ value: mode, label: MODE_LABELS[mode] }))
  const canCreate = Boolean(workspaceId && agentId && selectedMode && addressDraft.trim() && displayNameDraft.trim())

  const badge = load.status === 'loading'
    ? 'Checking'
    : load.status === 'error'
      ? 'Unavailable'
      : STATUS_BADGES[resolveEmailChannelStatus(load.status === 'ready', agentMailboxes) ?? 'off']

  const createMailbox = async () => {
    if (!workspaceId || !canCreate || isCreating || !selectedMode) return
    setIsCreating(true)
    setCreateError(null)
    try {
      const created = await emailChannelApi.createMailbox(workspaceId, {
        address: addressDraft.trim(),
        displayName: displayNameDraft.trim(),
        agentId,
        engagementMode: selectedMode,
      })
      handleMailboxChanged(created)
      setAddressDraft('')
      setDisplayNameDraft('')
      focusMailboxRef.current = created.id
      announce('Mailbox added.')
      void loadOverview({ quiet: true })
    } catch (error) {
      setCreateError(emailChannelErrorMessage(error, 'Failed to add the mailbox.'))
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <SettingsCard
      id="email-channel"
      icon={<Mail className="h-5 w-5 text-primary" />}
      title="Email"
      description="Answer mail sent to your own support address."
      headerEnd={<Badge variant={badge === 'On' ? 'outline' : 'secondary'}>{badge}</Badge>}
    >
      <div className="space-y-6">
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>

        {load.status === 'loading' ? (
          <div className="flex h-16 items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" />
            Loading email...
          </div>
        ) : null}

        {load.status === 'error' ? (
          <div className="flex flex-wrap items-center gap-3 rounded-xl bg-muted/50 p-4">
            <p className="text-sm text-destructive" role="alert">{load.message}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void loadOverview({ quiet: false })}>Retry</Button>
          </div>
        ) : null}

        {load.status === 'unavailable' ? (
          <div className="space-y-1 rounded-xl bg-muted/50 p-4">
            <p className="text-sm font-medium text-foreground">Email isn’t enabled on this server.</p>
            <p className="text-xs text-muted-foreground">
              Set EMAIL_CHANNEL_PROVIDER and EMAIL_CHANNEL_INBOUND_DOMAIN on the backend, then restart Radioso.
            </p>
          </div>
        ) : null}

        {overview && workspaceId ? (
          <>
            <div className="space-y-3">
              <h4 className="text-sm font-medium text-foreground">Mailboxes</h4>
              {agentMailboxes.length === 0 ? <p className="text-sm text-muted-foreground">No mailboxes yet.</p> : null}
              {agentMailboxes.map((mailbox) => (
                <EmailMailboxPanel
                  key={mailbox.id}
                  workspaceId={workspaceId}
                  mailbox={mailbox}
                  supportedModes={supportedModes}
                  headingRef={(element) => {
                    if (element) mailboxHeadings.current.set(mailbox.id, element)
                    else mailboxHeadings.current.delete(mailbox.id)
                  }}
                  onMailboxChanged={handleMailboxChanged}
                  announce={announce}
                />
              ))}
            </div>

            <form
              className="max-w-md space-y-3"
              onSubmit={(event) => {
                event.preventDefault()
                void createMailbox()
              }}
            >
              <h4 className="text-sm font-medium text-foreground">Add a mailbox</h4>
              <div className="space-y-2">
                <Label htmlFor="email-mailbox-address" className="text-foreground">Address</Label>
                <Input
                  id="email-mailbox-address"
                  type="email"
                  value={addressDraft}
                  onChange={(event) => setAddressDraft(event.target.value)}
                  placeholder="support@yourcompany.com"
                  autoComplete="off"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email-mailbox-display-name" className="text-foreground">Display name</Label>
                <Input
                  id="email-mailbox-display-name"
                  value={displayNameDraft}
                  onChange={(event) => setDisplayNameDraft(event.target.value)}
                  placeholder="Support"
                  autoComplete="off"
                />
              </div>
              {selectedMode ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-foreground">Mode</span>
                  <SegmentedControl aria-label="Mode" value={selectedMode} onValueChange={setModeDraft} options={modeOptions} />
                </div>
              ) : null}
              <Button type="submit" disabled={!canCreate} aria-busy={isCreating || undefined}>
                {isCreating ? <Loader2 className="animate-spin" aria-hidden /> : null}
                Add mailbox
              </Button>
              {createError ? <p className="text-sm text-destructive" role="alert">{createError}</p> : null}
            </form>

            <EmailDomainRecords
              workspaceId={workspaceId}
              domains={overview.domains}
              onDomainChanged={handleDomainChanged}
              announce={announce}
            />
          </>
        ) : null}
      </div>
    </SettingsCard>
  )
}

type EmailMailboxPanelProps = {
  workspaceId: string
  mailbox: EmailMailbox
  supportedModes: readonly EmailEngagementMode[]
  headingRef: (element: HTMLHeadingElement | null) => void
  onMailboxChanged: (mailbox: EmailMailbox) => void
  announce: (message: string) => void
}

function EmailMailboxPanel({ workspaceId, mailbox, supportedModes, headingRef, onMailboxChanged, announce }: EmailMailboxPanelProps) {
  const headingId = useId()
  const silentSince = mailbox.receiving.state === 'silent' && mailbox.receiving.lastReceivedAt
    ? relativeTimestamp(mailbox.receiving.lastReceivedAt)
    : null

  return (
    <section aria-labelledby={headingId} className="space-y-4 rounded-xl border border-border bg-muted/30 p-4">
      <div className="space-y-2">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h5 id={headingId} ref={headingRef} tabIndex={-1} className="text-sm font-medium text-foreground outline-none">
            {mailbox.address}
          </h5>
          <span className="text-xs text-muted-foreground">{mailbox.displayName} · Mode: {MODE_LABELS[mailbox.engagementMode]}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant={mailbox.receiving.state === 'ok' ? 'outline' : 'secondary'}>Receiving: {receivingLabel(mailbox.receiving)}</Badge>
          <Badge variant={mailbox.sending.state === 'ok' ? 'outline' : 'secondary'}>Sending: {SENDING_LABELS[mailbox.sending.state]}</Badge>
          {!mailbox.enabled ? <Badge variant="secondary">Disabled</Badge> : null}
        </div>
        {silentSince ? (
          <p className="text-xs text-destructive">No mail since {silentSince}. Forwarding may have stopped.</p>
        ) : null}
      </div>

      <EmailMailboxMode
        workspaceId={workspaceId}
        mailbox={mailbox}
        supportedModes={supportedModes}
        onMailboxChanged={onMailboxChanged}
        announce={announce}
      />

      <CopyValueField label="Relay address" value={mailbox.relayAddress} ariaLabel="Copy relay address" />

      <ForwardingSteps address={mailbox.address} />

      <MailboxSetupCheck workspaceId={workspaceId} mailbox={mailbox} onMailboxChanged={onMailboxChanged} announce={announce} />

      <EmailMailboxEvents workspaceId={workspaceId} mailboxId={mailbox.id} announce={announce} />
    </section>
  )
}

function ForwardingSteps({ address }: { address: string }) {
  return (
    <Tabs defaultValue="google">
      <TabsList aria-label="Forward from">
        <TabsTrigger value="google">Google Workspace</TabsTrigger>
        <TabsTrigger value="microsoft">Microsoft 365</TabsTrigger>
      </TabsList>
      <TabsContent value="google">
        <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
          <li>In Gmail settings, add the relay address as a forwarding address.</li>
          <li>Google mails it a confirmation code. Open Events below, then View raw, and enter the code in Gmail.</li>
          <li>Forward a copy of incoming mail to the relay address.</li>
        </ol>
      </TabsContent>
      <TabsContent value="microsoft">
        <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
          <li>First allow external forwarding: turn on automatic forwarding in the outbound anti-spam policy.</li>
          <li>Then add a forwarding rule from {address} to the relay address.</li>
        </ol>
      </TabsContent>
    </Tabs>
  )
}

type MailboxSetupCheckProps = {
  workspaceId: string
  mailbox: EmailMailbox
  onMailboxChanged: (mailbox: EmailMailbox) => void
  announce: (message: string) => void
}

const setupCheckAnnouncement = (state: SetupCheckState): string | null => {
  switch (state.phase) {
    case 'waiting':
      return `Waiting for a message to ${state.sendTo}.`
    case 'passed':
      return 'Setup check passed.'
    case 'timed_out':
      return 'Setup check timed out.'
    case 'failed':
      return state.message
    default:
      return null
  }
}

/**
 * Runs the two-step setup check. Its button stays mounted through every phase,
 * so keyboard focus stays on it while the check runs.
 */
function MailboxSetupCheck({ workspaceId, mailbox, onMailboxChanged, announce }: MailboxSetupCheckProps) {
  const mailboxId = mailbox.id
  const [state, setState] = useState<SetupCheckState>(() => initialSetupCheckState(mailbox.setupCheck, Date.now()))
  const nextRequest = setupCheckNextRequest(state)
  const isRunning = nextRequest !== null
  const stepToStart = nextRequest?.kind === 'start' ? nextRequest.step : null

  useEffect(() => {
    if (!stepToStart) return
    let active = true
    emailChannelApi.startSetupCheck(workspaceId, mailboxId, stepToStart).then(
      (check) => { if (active) setState((current) => advanceSetupCheck(current, { type: 'started', check, nowMs: Date.now() })) },
      (error: unknown) => {
        if (active) setState((current) => advanceSetupCheck(current, { type: 'request_failed', message: emailChannelErrorMessage(error, 'Failed to start the setup check.') }))
      },
    )
    return () => { active = false }
  }, [mailboxId, stepToStart, workspaceId])

  useEffect(() => {
    if (state.phase !== 'waiting') return
    let active = true
    let inFlight = false
    const timer = window.setInterval(() => {
      if (inFlight) return
      inFlight = true
      emailChannelApi.getMailbox(workspaceId, mailboxId).then(
        (next) => {
          if (!active) return
          onMailboxChanged(next)
          setState((current) => advanceSetupCheck(current, { type: 'polled', check: next.setupCheck, nowMs: Date.now() }))
        },
        (error: unknown) => {
          if (active) setState((current) => advanceSetupCheck(current, { type: 'request_failed', message: emailChannelErrorMessage(error, 'Failed to check the mailbox.') }))
        },
      ).finally(() => { inFlight = false })
    }, SETUP_CHECK_POLL_MS)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [mailboxId, onMailboxChanged, state, workspaceId])

  useEffect(() => {
    const message = setupCheckAnnouncement(state)
    if (message) announce(message)
  }, [announce, state])

  const run = () => {
    if (!isRunning) setState((current) => advanceSetupCheck(current, { type: 'start' }))
  }

  const buttonLabel = state.phase === 'idle' ? 'Run setup check' : isRunning ? 'Checking' : state.phase === 'passed' ? 'Run again' : 'Try again'

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={run}
          aria-disabled={isRunning || undefined}
          aria-busy={isRunning || undefined}
          className={isRunning ? 'opacity-60' : undefined}
        >
          {isRunning ? <Loader2 className="animate-spin" aria-hidden /> : <MailCheck aria-hidden />}
          {buttonLabel}
        </Button>
        {state.phase === 'idle' ? <span className="text-xs text-muted-foreground">Confirms forwarding works.</span> : null}
        {state.phase === 'passed' ? (
          <span className="inline-flex items-center gap-1 text-sm text-foreground">
            <CheckCircle2 className="h-4 w-4 text-primary" aria-hidden />
            Forwarding works.
          </span>
        ) : null}
      </div>
      {state.phase === 'waiting' ? (
        <div className="space-y-0.5">
          <p className="text-xs text-muted-foreground">Step {state.step === 'base' ? 1 : 2} of 2</p>
          <p className="text-sm text-foreground">Send any message to {state.sendTo}.</p>
        </div>
      ) : null}
      {state.phase === 'timed_out' ? (
        <p className="text-sm text-destructive">Nothing arrived. Check the forwarding rule, then try again.</p>
      ) : null}
      {state.phase === 'failed' ? <p className="text-sm text-destructive" role="alert">{state.message}</p> : null}
    </div>
  )
}
