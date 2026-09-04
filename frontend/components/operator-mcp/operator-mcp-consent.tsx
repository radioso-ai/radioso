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
  'operator:read': 'Read workspace and agent state',
  'operator:probe': 'Run bounded diagnostics and retrieval probes',
  'operator:act': 'Perform admitted safe operational effects',
  'operator:propose': 'Create reviewable proposals without applying them',
}

const isSensitiveRedirect = (redirectUri: string): boolean => {
  try {
    const parsed = new URL(redirectUri)
    return parsed.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  } catch {
    return true
  }
}

export const consentWarnings = (transaction: OperatorMcpTransactionResponse): string[] => {
  const warnings = ['The requesting client may receive workspace data available to your current access. Radioso does not certify this external client.']
  if (isSensitiveRedirect(transaction.redirectUri)) warnings.push('This client uses a loopback or private-scheme redirect. Verify that the redirect host belongs to the client you intended to connect.')
  return warnings
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
        <CardHeader className="space-y-4">
          <div className="flex items-start justify-between gap-4"><div><CardTitle>Authorize Radioso MCP</CardTitle><CardDescription className="mt-1">Review what {transaction.client.displayName} is asking to access.</CardDescription></div><LockKeyhole className="h-5 w-5 text-primary" aria-hidden /></div>
          <div className="grid gap-3 rounded-xl border border-border bg-muted/30 p-4 text-sm sm:grid-cols-2">
            <div><p className="text-muted-foreground">Client</p><p className="font-medium">{transaction.client.displayName}{transaction.client.clientVersion ? ` · ${transaction.client.clientVersion}` : ''}</p><p className="break-all text-xs text-muted-foreground">{transaction.client.clientId}</p></div>
            <div><p className="text-muted-foreground">Redirect host</p><p className="font-medium">{transaction.redirectHost}</p><p className="break-all text-xs text-muted-foreground">{transaction.redirectUri}</p></div>
            <div><p className="text-muted-foreground">Signed-in user</p><p className="font-medium">{transaction.currentUser.displayName}</p><p className="text-xs text-muted-foreground">{transaction.currentUser.email}</p></div>
            <div><p className="text-muted-foreground">Request expires</p><p className="font-medium">{new Date(transaction.expiresAt).toLocaleString()}</p></div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2"><label htmlFor="operator-mcp-workspace" className="text-sm font-medium">Workspace</label><select id="operator-mcp-workspace" className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>{transaction.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name} · {workspace.role}</option>)}</select></div>
          <fieldset className="space-y-3"><legend className="text-sm font-medium">Capabilities</legend>{transaction.requestedScopes.map((scope) => <label key={scope} className="flex items-start gap-3 rounded-lg border border-border p-3 text-sm"><input type="checkbox" checked={scopes.includes(scope)} onChange={(event) => setScopes((current) => event.target.checked ? [...current, scope] : current.filter((item) => item !== scope))} /><span><span className="font-medium">{scopeLabels[scope]}</span><span className="block text-xs text-muted-foreground">{scope}</span></span></label>)}</fieldset>
          {transaction.requestedOfflineAccess ? <label className="flex items-start gap-3 rounded-lg border border-border p-3 text-sm"><input type="checkbox" checked={offlineAccess} onChange={(event) => setOfflineAccess(event.target.checked)} /><span><span className="font-medium">Keep access for future sessions</span><span className="block text-xs text-muted-foreground">Allow a refresh credential. You can revoke this grant from API access at any time.</span></span></label> : null}
          <div className="space-y-2 rounded-xl border border-amber-300/50 bg-amber-50/50 p-4 text-sm dark:bg-amber-950/20">{warnings.map((warning) => <p key={warning} className="flex gap-2 text-muted-foreground"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />{warning}</p>)}</div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">Resource: <span className="break-all">{transaction.resource}</span></p><div className="flex gap-2"><Button type="button" variant="ghost" onClick={() => void decide('deny')} disabled={submitting}>Cancel</Button><Button type="button" variant="outline" onClick={() => void decide('deny')} disabled={submitting}>Deny</Button><Button type="button" onClick={() => void decide('approve')} disabled={submitting || decisionUnavailable}>{submitting ? <Spinner className="mr-2 h-4 w-4" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}Approve access</Button></div></div>
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
