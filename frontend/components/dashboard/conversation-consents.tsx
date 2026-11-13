'use client'

import { useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Spinner } from '@/components/ui/spinner'
import { chatApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import type { ConversationConsent } from '@/lib/api-types'
import {
  canWithdrawConsent,
  consentAfterRefusedWithdrawal,
  consentStatus,
  withConsent,
  type ConsentStatus,
} from '@/lib/conversation-consents'
import { getConversationSourceBadge } from '@/lib/history-source'
import { useWorkspaceCanManage } from '@/lib/use-workspace-can-manage'

const timestampFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const formatTime = (iso: string) => timestampFormatter.format(new Date(iso))

const STATUS_BADGE: Record<ConsentStatus, { label: string; variant: 'secondary' | 'outline' }> = {
  granted: { label: 'Granted', variant: 'secondary' },
  declined: { label: 'Declined', variant: 'outline' },
  withdrawn: { label: 'Withdrawn', variant: 'outline' },
}

function ConsentRow({
  consent,
  routineName,
  canManage,
  onWithdraw,
}: {
  consent: ConversationConsent
  routineName: string | undefined
  canManage: boolean
  onWithdraw: (consent: ConversationConsent) => void
}) {
  const status = consentStatus(consent)
  const badge = STATUS_BADGE[status]
  const channel = consent.channel ? getConversationSourceBadge(consent.channel)?.label ?? consent.channel : null
  const facts = [consent.locale, channel, formatTime(consent.decidedAt)].filter(Boolean).join(' · ')

  return (
    <li className="py-2" data-testid="conversation-consent">
      <Collapsible>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm text-foreground">{routineName ?? consent.consentKey}</span>
              <Badge variant={badge.variant}>{badge.label}</Badge>
              {consent.defaulted ? <span className="text-xs text-muted-foreground">no clear answer</span> : null}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {facts}
              {consent.withdrawnAt ? ` · Withdrawn ${formatTime(consent.withdrawnAt)}` : null}
            </p>
            <CollapsibleTrigger className="group mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" aria-hidden />
              Wording
            </CollapsibleTrigger>
          </div>
          {canManage && canWithdrawConsent(consent) ? (
            <Button type="button" size="sm" variant="outline" onClick={() => onWithdraw(consent)}>
              Withdraw
            </Button>
          ) : null}
        </div>
        <CollapsibleContent className="mt-2 rounded-md bg-muted/50 p-3 text-sm text-foreground">
          <p className="whitespace-pre-wrap">{consent.wording.body}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            {consent.wording.agreeLabel} · {consent.wording.declineLabel}
          </p>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

/**
 * The consent decisions a visitor gave in the conversation's routines (#1544), with each one's
 * wording, and — for whoever holds `workspace.history.delete` — the withdrawal of a granted one on
 * the visitor's request. Shows nothing for a conversation without consents. After a withdrawal,
 * `onWithdrawn` lets the drawer reload the thread, whose withheld messages then read as such.
 */
export function ConversationConsents({
  conversationId,
  routineNamesById,
  onWithdrawn,
  className,
}: {
  conversationId: string
  routineNamesById?: ReadonlyMap<string, string>
  onWithdrawn: () => void
  className?: string
}) {
  const { canManage } = useWorkspaceCanManage()
  const [consents, setConsents] = useState<ConversationConsent[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pending, setPending] = useState<ConversationConsent | null>(null)
  const [withdrawing, setWithdrawing] = useState(false)
  const [withdrawError, setWithdrawError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    // Deferred, like useVisitorConversations: a synchronous setState in an effect body cascades renders.
    queueMicrotask(() => {
      if (controller.signal.aborted) return
      setConsents([])
      setLoadError(null)
      chatApi.listConversationConsents(conversationId, controller.signal)
        .then((loaded) => {
          if (!controller.signal.aborted) setConsents(loaded)
        })
        .catch((caught: unknown) => {
          if (!controller.signal.aborted) setLoadError(getApiErrorMessage(caught, "Couldn't load consents"))
        })
    })
    return () => controller.abort()
  }, [conversationId])

  if (consents.length === 0 && !loadError) {
    return null
  }

  const handleConfirm = async () => {
    if (!pending) return
    setWithdrawing(true)
    setWithdrawError(null)
    try {
      const withdrawn = await chatApi.withdrawConversationConsent(conversationId, pending.id)
      setConsents((current) => withConsent(current, withdrawn))
      setPending(null)
      onWithdrawn()
    } catch (caught) {
      const current = consentAfterRefusedWithdrawal(caught)
      if (current) {
        // Someone withdrew it first, or it was never granted: show it as it stands.
        setConsents((existing) => withConsent(existing, current))
        setPending(null)
        onWithdrawn()
      } else {
        setWithdrawError(getApiErrorMessage(caught, 'The consent could not be withdrawn.'))
      }
    } finally {
      setWithdrawing(false)
    }
  }

  return (
    <section aria-label="Consents" className={className}>
      <div className="rounded-lg border border-border/70 bg-background/70 p-4">
        <p className="text-sm font-medium text-foreground">Consents</p>
        {loadError ? (
          <p className="mt-1 text-sm text-destructive">{loadError}</p>
        ) : (
          <ul className="mt-1 divide-y divide-border/70">
            {consents.map((consent) => (
              <ConsentRow
                key={consent.id}
                consent={consent}
                routineName={routineNamesById?.get(consent.routineId)}
                canManage={canManage}
                onWithdraw={(target) => {
                  setWithdrawError(null)
                  setPending(target)
                }}
              />
            ))}
          </ul>
        )}
      </div>
      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (withdrawing) return
          if (!open) {
            setPending(null)
            setWithdrawError(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Withdraw this consent?</AlertDialogTitle>
            <AlertDialogDescription>
              The answers it covered are erased and the messages that held them are withheld. The record stays as proof.
              Text already sent to Slack or WhatsApp stays there.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {withdrawError ? (
            <p className="text-sm text-destructive" role="alert">
              {withdrawError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={withdrawing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault()
                void handleConfirm()
              }}
              disabled={withdrawing}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {withdrawing ? (
                <>
                  <Spinner className="mr-2 h-4 w-4" />
                  Withdrawing...
                </>
              ) : (
                'Withdraw consent'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
