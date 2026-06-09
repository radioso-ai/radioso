'use client'

import { useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { LogoSpinner } from '@/components/ui/spinner'
import {
  accountApi,
  agentsApi,
  workspaceApi,
  type AgentListResponse,
  type UsageTrendsResponse,
  type Workspace,
} from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import {
  defaultUsageTrendQuery,
  findPeakUsageTrendBucket,
  formatUsageTrendBucketLabel,
  summarizeUsageTrends,
  type UsageTrendGranularity,
  type UsageTrendQueryState,
} from '@/lib/usage-trends'

const numberFormatter = new Intl.NumberFormat()
const ALL_FILTER_VALUE = 'all'

const formatCount = (value: number) => numberFormatter.format(value)

function MetricCard({
  label,
  value,
  caption,
}: {
  label: string
  value: number
  caption: string
}) {
  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-sm font-medium">{label}</CardTitle>
        <CardDescription>{caption}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tracking-normal">{formatCount(value)}</div>
      </CardContent>
    </Card>
  )
}

function TrendsBars({ trends }: { trends: UsageTrendsResponse }) {
  const peak = findPeakUsageTrendBucket(trends)
  const maxTokens = Math.max(1, peak?.tokens.total ?? 0)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Trend series</CardTitle>
        <CardDescription>UTC buckets from {trends.from} through {trends.to}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {trends.buckets.map((bucket) => {
            const width = Math.max(2, Math.round((bucket.tokens.total / maxTokens) * 100))
            return (
              <div key={bucket.periodStart} className="grid grid-cols-[5.5rem_1fr_4rem] items-center gap-3 text-sm">
                <div className="truncate text-muted-foreground">{formatUsageTrendBucketLabel(bucket, trends.granularity)}</div>
                <div className="h-3 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-foreground" style={{ width: `${width}%` }} />
                </div>
                <div className="text-right tabular-nums">{formatCount(bucket.tokens.total)}</div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

export function UsageTrendsView() {
  const [query, setQuery] = useState<UsageTrendQueryState>(() => defaultUsageTrendQuery())
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [agents, setAgents] = useState<AgentListResponse['agents']>([])
  const [trends, setTrends] = useState<UsageTrendsResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let active = true

    const load = async () => {
      setIsLoading(true)
      setError(null)
      try {
        const [workspaceList, agentList, trendResponse] = await Promise.all([
          workspaceApi.list(),
          agentsApi.listAgents(),
          accountApi.getUsageTrends(query),
        ])
        if (!active) return
        setWorkspaces(workspaceList)
        setAgents(agentList.agents)
        setTrends(trendResponse)
      } catch (nextError) {
        if (!active) return
        setError(getApiErrorMessage(nextError, 'Failed to load usage trends.'))
      } finally {
        if (active) {
          setIsLoading(false)
        }
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [query, reloadKey])

  const totals = useMemo(() => trends ? summarizeUsageTrends(trends) : null, [trends])

  const updateQuery = (patch: Partial<UsageTrendQueryState>) => {
    setQuery((current) => ({ ...current, ...patch }))
  }

  return (
    <div className="space-y-6" data-testid="usage-trends">
      <Card>
        <CardHeader>
          <CardTitle>Usage trends</CardTitle>
          <CardDescription>Conversations, messages, and succeeded token usage by UTC period.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
            <div className="space-y-2">
              <Label htmlFor="usage-trends-from">From</Label>
              <Input
                id="usage-trends-from"
                type="date"
                value={query.from}
                onChange={(event) => updateQuery({ from: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="usage-trends-to">To</Label>
              <Input
                id="usage-trends-to"
                type="date"
                value={query.to}
                onChange={(event) => updateQuery({ to: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Granularity</Label>
              <Select value={query.granularity} onValueChange={(value) => updateQuery({ granularity: value as UsageTrendGranularity })}>
                <SelectTrigger className="w-full" aria-label="Granularity">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="day">Daily</SelectItem>
                  <SelectItem value="week">Weekly</SelectItem>
                  <SelectItem value="month">Monthly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Workspace</Label>
              <Select
                value={query.workspaceId ?? ALL_FILTER_VALUE}
                onValueChange={(value) => updateQuery({ workspaceId: value === ALL_FILTER_VALUE ? undefined : value })}
              >
                <SelectTrigger className="w-full" aria-label="Workspace">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_FILTER_VALUE}>All workspaces</SelectItem>
                  {workspaces.map((workspace) => (
                    <SelectItem key={workspace.id} value={workspace.id}>{workspace.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Agent</Label>
              <Select
                value={query.agentId ?? ALL_FILTER_VALUE}
                onValueChange={(value) => updateQuery({ agentId: value === ALL_FILTER_VALUE ? undefined : value })}
              >
                <SelectTrigger className="w-full" aria-label="Agent">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_FILTER_VALUE}>All agents</SelectItem>
                  {agents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>{agent.name || 'Untitled agent'}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end">
              <Button type="button" variant="outline" className="w-full" onClick={() => setReloadKey((value) => value + 1)}>
                <RefreshCw className="size-4" aria-hidden />
                Refresh
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="flex min-h-48 items-center justify-center">
          <LogoSpinner imageClassName="h-7 w-7" />
        </div>
      ) : error ? (
        <Card>
          <CardHeader>
            <CardTitle>Trends unavailable</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
        </Card>
      ) : trends && totals ? (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <MetricCard label="Conversations" value={totals.conversationsCreated} caption="Created in the selected range." />
            <MetricCard label="Messages" value={totals.messages.total} caption={`${formatCount(totals.messages.user)} user, ${formatCount(totals.messages.assistant)} assistant.`} />
            <MetricCard label="Tokens" value={totals.tokens.total} caption={`${formatCount(totals.tokens.input)} input, ${formatCount(totals.tokens.output)} output.`} />
          </div>
          <TrendsBars trends={trends} />
        </>
      ) : null}
    </div>
  )
}
