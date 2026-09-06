'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, ExternalLink, LockKeyhole } from 'lucide-react'

import { getApiErrorMessage } from '@/lib/api-error'
import { operatorMcpApi, type OperatorMcpToolScope, type OperatorMcpTransactionResponse } from '@/lib/api-operator-mcp'
import { useAuth } from '@/lib/auth-context'
import { AuthPage } from '@/components/auth/auth-page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'

const scopeLabels: Record<OperatorMcpToolScope, string> = {
  'operator:read': 'View workspace settings',
  'operator:probe': 'Run document searches',
  'operator:act': 'Make workspace changes',
  'operator:propose': 'Draft changes for review',
}

export const consentWarnings = (transaction: OperatorMcpTransactionResponse): string[] => {
  return [`${transaction.client.displayName} receives only the permissions you select.`]
}

type ConsentState =
  | { kind: 'loading' }
  | { kind: 'auth' }
  | { kind: 'ready'; transaction: OperatorMcpTransactionResponse }
  | { kind: 'error'; message: string }
  | { kind: 'decided'; message: string }

const isUnauthorizedApiError = (error: unknown): boolean => (
  Boolean(error && typeof error === 'object' && 'status' in error && error.status === 401)
)

export function OperatorMcpConsent({ transactionId }: { transactionId: string }) {
  const { user, isAuthenticated, isBootstrapping } = useAuth()
  const [state, setState] = useState<ConsentState>({ kind: 'loading' })
  const [workspaceId, setWorkspaceId] = useState('')
  const [scopes, setScopes] = useState<OperatorMcpToolScope[]>([])
  const [offlineAccess, setOfflineAccess] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (isBootstrapping) return
    const controller = new AbortController()
    void operatorMcpApi.getTransaction(transactionId, controller.signal)
      .then((transaction) => {
        setState({ kind: 'ready', transaction })
        setWorkspaceId(transaction.workspaces[0]?.id ?? '')
        setScopes(transaction.requestedScopes)
        // A client may request refresh authority, but the operator must opt in to
        // that lifecycle scope independently from the tool scopes.
        setOfflineAccess(false)
      })
      .catch((loadError) => {
        if (controller.signal.aborted) return
        if (isUnauthorizedApiError(loadError)) {
          setState({ kind: 'auth' })
          return
        }
        setState({ kind: 'error', message: getApiErrorMessage(loadError, 'This authorization request is no longer available.') })
      })
    return () => controller.abort()
  }, [isAuthenticated, isBootstrapping, transactionId])

  useEffect(() => {
    document.title = 'Authorize Radioso MCP'
    const meta = document.createElement('meta')
    meta.name = 'referrer'
    meta.content = 'no-referrer'
    document.head.appendChild(meta)
    return () => { meta.remove() }
  }, [])

  const transaction = state.kind === 'ready' ? state.transaction : null
  const warnings = useMemo(() => transaction ? consentWarnings(transaction) : [], [transaction])
  const accountMismatch = Boolean(transaction && user && transaction.currentUser.id !== user.userId)
  const noAccess = Boolean(transaction && transaction.workspaces.length === 0)
  const decisionUnavailable = !transaction || transaction.status !== 'pending' || accountMismatch || noAccess || !workspaceId || scopes.length === 0

  const decide = async (decision: 'approve' | 'deny') => {
    if (!transaction || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await operatorMcpApi.decideTransaction(transaction.transactionId, {
        decision,
        ...(decision === 'approve' ? { workspaceId, approvedToolScopes: scopes, offlineAccess } : { offlineAccess: false }),
      })
      setState({ kind: 'decided', message: decision === 'approve' ? 'Authorization approved. Returning to the client…' : 'Authorization denied.' })
      window.location.assign(result.redirectUrl)
    } catch (decisionError) {
      setError(getApiErrorMessage(decisionError, 'This authorization request changed or expired. Start again from your client.'))
    } finally {
      setSubmitting(false)
    }
  }

  if (isBootstrapping) return <ConsentShell><Spinner className="h-6 w-6" /></ConsentShell>
  if (state.kind === 'auth') {
    return <AuthPage returnTo={`/oauth/operator-mcp/consent?transaction=${encodeURIComponent(transactionId)}`} />
  }
  if (state.kind === 'loading') return <ConsentShell><Spinner className="h-6 w-6" /></ConsentShell>
  if (state.kind === 'error') return <ConsentShell><StatePanel title="Authorization unavailable" message={state.message} /></ConsentShell>
  if (state.kind === 'decided') return <ConsentShell><StatePanel title="Authorization decided" message={state.message} /></ConsentShell>
  if (!transaction) return null
  if (accountMismatch) return <ConsentShell><StatePanel title="Sign in as the requesting user" message="This authorization was started by a different account session. Return to the client and start again." /></ConsentShell>
  if (transaction.status !== 'pending') return <ConsentShell><StatePanel title={transaction.status === 'expired' ? 'Authorization expired' : 'Authorization already decided'} message="This one-time authorization request cannot be reused. Start again from your client." /></ConsentShell>
  if (noAccess) return <ConsentShell><StatePanel title="No workspace access" message="Your current account has no workspace that can authorize this client." /></ConsentShell>

  return (
    <ConsentShell>
      <Card className="w-full max-w-2xl">
        <CardHeader className="space-y-3">
          <div className="flex items-start justify-between gap-4"><div><CardTitle>Authorize Radioso MCP</CardTitle><CardDescription className="mt-1">Choose what {transaction.client.displayName} can do.</CardDescription></div><LockKeyhole className="h-5 w-5 text-primary" aria-hidden /></div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2"><label htmlFor="operator-mcp-workspace" className="text-sm font-medium">Workspace</label><select id="operator-mcp-workspace" className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>{transaction.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name} · {workspace.role}</option>)}</select></div>
          <fieldset className="space-y-0"><legend className="mb-1 text-sm font-medium">Allow {transaction.client.displayName} to</legend>{transaction.requestedScopes.map((scope) => <label key={scope} className="flex items-center gap-3 border-b border-border py-3 text-sm first:border-t"><input type="checkbox" checked={scopes.includes(scope)} onChange={(event) => setScopes((current) => event.target.checked ? [...current, scope] : current.filter((item) => item !== scope))} /><span className="font-medium">{scopeLabels[scope]}</span></label>)}</fieldset>
          {transaction.requestedOfflineAccess ? <label className="flex items-start gap-3 border-t border-border pt-4 text-sm"><input type="checkbox" checked={offlineAccess} onChange={(event) => setOfflineAccess(event.target.checked)} /><span><span className="font-medium">Stay signed in</span><span className="block text-xs text-muted-foreground">Keep access until you revoke it.</span></span></label> : null}
          <div className="space-y-1 text-sm">{warnings.map((warning) => <p key={warning} className="flex gap-2 text-muted-foreground"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />{warning}</p>)}</div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => void decide('deny')} disabled={submitting}>Don't allow</Button><Button type="button" onClick={() => void decide('approve')} disabled={submitting || decisionUnavailable}>{submitting ? <Spinner className="mr-2 h-4 w-4" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}Approve access</Button></div>
        </CardContent>
      </Card>
    </ConsentShell>
  )
}

function ConsentShell({ children }: { children: ReactNode }) {
  return <main className="flex min-h-screen items-center justify-center bg-muted/20 p-4 sm:p-8" style={{ isolation: 'isolate' }}>{children}</main>
}

function StatePanel({ title, message }: { title: string; message: string }) {
  return <Card className="w-full max-w-md"><CardHeader><CardTitle>{title}</CardTitle><CardDescription>{message}</CardDescription></CardHeader><CardContent><Button type="button" variant="outline" onClick={() => window.close()}><ExternalLink className="mr-2 h-4 w-4" />Close</Button></CardContent></Card>
}
