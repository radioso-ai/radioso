'use client'

import { useCallback, useEffect, useState } from 'react'

import { accountApi, type AccountUsageSummary, type TokenUsageTotals } from '@/lib/api'
import { Spinner } from '@/components/ui/spinner'

const numberFormatter = new Intl.NumberFormat()

const formatTokens = (value: number) => numberFormatter.format(value)

function UsageCard({
  label,
  totals,
}: {
  label: string
  totals: TokenUsageTotals
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-foreground">{formatTokens(totals.totalTokens)}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Prompt {formatTokens(totals.promptTokens)} · Completion {formatTokens(totals.completionTokens)}
      </p>
    </div>
  )
}

export function UsageView() {
  const [usage, setUsage] = useState<AccountUsageSummary | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadUsage = useCallback(async () => {
    setIsLoading(true)
    setError(null)

    try {
      const nextUsage = await accountApi.getUsage()
      setUsage(nextUsage)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to load usage.')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadUsage()
  }, [loadUsage])

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    )
  }

  if (error || !usage) {
    return (
      <div className="p-6">
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          {error ?? 'Failed to load usage.'}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-border px-6 py-4">
        <h1 className="text-lg font-medium text-foreground">Usage</h1>
        <p className="text-sm text-muted-foreground">
          Account-wide token usage across all workspaces.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-5xl space-y-8">
          <div className="grid gap-4 md:grid-cols-2">
            <UsageCard label="Today" totals={usage.today} />
            <UsageCard label="Current Month" totals={usage.currentMonth} />
          </div>

          <section className="space-y-3">
            <div>
              <h2 className="text-sm font-medium uppercase tracking-wide text-foreground">Recent Days</h2>
              <p className="text-sm text-muted-foreground">Daily totals across all workspaces.</p>
            </div>
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              {usage.daily.length === 0 ? (
                <div className="p-4 text-sm text-muted-foreground">No usage recorded yet.</div>
              ) : (
                <div className="divide-y divide-border">
                  {usage.daily.map((row) => (
                    <div key={row.date} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                      <div>
                        <p className="font-medium text-foreground">{row.date}</p>
                        <p className="text-muted-foreground">
                          Prompt {formatTokens(row.totals.promptTokens)} · Completion {formatTokens(row.totals.completionTokens)}
                        </p>
                      </div>
                      <p className="font-mono text-foreground">{formatTokens(row.totals.totalTokens)}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="space-y-3">
            <div>
              <h2 className="text-sm font-medium uppercase tracking-wide text-foreground">Recent Months</h2>
              <p className="text-sm text-muted-foreground">Monthly totals derived from daily summaries.</p>
            </div>
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              {usage.monthly.length === 0 ? (
                <div className="p-4 text-sm text-muted-foreground">No monthly usage recorded yet.</div>
              ) : (
                <div className="divide-y divide-border">
                  {usage.monthly.map((row) => (
                    <div key={row.month} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                      <div>
                        <p className="font-medium text-foreground">{row.month}</p>
                        <p className="text-muted-foreground">
                          Prompt {formatTokens(row.totals.promptTokens)} · Completion {formatTokens(row.totals.completionTokens)}
                        </p>
                      </div>
                      <p className="font-mono text-foreground">{formatTokens(row.totals.totalTokens)}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
