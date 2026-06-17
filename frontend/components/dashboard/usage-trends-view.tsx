'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

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
  formatUsageTrendBucketLabel,
  isAgentFilterScopedOut,
  type UsageTrendGranularity,
  type UsageTrendQueryState,
} from '@/lib/usage-trends'

const numberFormatter = new Intl.NumberFormat()
const compactNumberFormatter = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
})
const ALL_FILTER_VALUE = 'all'

const formatCount = (value: number) => numberFormatter.format(value)
const formatCompactCount = (value: number) => compactNumberFormatter.format(value)

type UsageChartMode = 'messages' | 'conversations' | 'tokens'

type UsageChartDatum = {
  label: string
  fullLabel: string
  conversations: number
  userMessages: number
  assistantMessages: number
  inputTokens: number
  outputTokens: number
}

const chartModes: Array<{ value: UsageChartMode; label: string }> = [
  { value: 'messages', label: 'Messages' },
  { value: 'conversations', label: 'Conversations' },
  { value: 'tokens', label: 'Tokens' },
]

const chartSeriesLabels: Record<string, string> = {
  conversations: 'Conversations',
  userMessages: 'User messages',
  assistantMessages: 'Assistant messages',
  inputTokens: 'Input tokens',
  outputTokens: 'Output tokens',
}

const buildUsageChartData = (trends: UsageTrendsResponse): UsageChartDatum[] => trends.buckets.map((bucket) => ({
  label: formatUsageTrendBucketLabel(bucket, trends.granularity),
  fullLabel: `${bucket.periodStart.slice(0, 10)} through ${bucket.periodEnd.slice(0, 10)}`,
  conversations: bucket.conversationsCreated,
  userMessages: bucket.messages.user,
  assistantMessages: bucket.messages.assistant,
  inputTokens: bucket.tokens.input,
  outputTokens: bucket.tokens.output,
}))

function UsagePeriodChart({
  trends,
}: {
  trends: UsageTrendsResponse
}) {
  const [chartMode, setChartMode] = useState<UsageChartMode>('messages')
  const [chartWidth, setChartWidth] = useState(0)
  const chartContainerRef = useRef<HTMLDivElement>(null)
  const chartData = useMemo(() => buildUsageChartData(trends), [trends])

  useEffect(() => {
    const element = chartContainerRef.current
    if (!element) return

    const updateChartWidth = () => {
      setChartWidth(Math.max(0, Math.floor(element.getBoundingClientRect().width)))
    }

    updateChartWidth()
    const observer = new ResizeObserver(updateChartWidth)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <Card>
      <CardHeader className="gap-4 md:flex-row md:items-start md:justify-between">
        <div className="space-y-1">
          <CardTitle>Usage by period</CardTitle>
          <CardDescription>{trends.granularity === 'day' ? 'Daily' : trends.granularity === 'week' ? 'Weekly' : 'Monthly'} bars from {trends.from} through {trends.to}.</CardDescription>
        </div>
        <div className="flex flex-wrap gap-2" aria-label="Usage metric">
          {chartModes.map((mode) => (
            <Button
              key={mode.value}
              type="button"
              size="sm"
              variant="outline"
              className={chartMode === mode.value ? 'border-foreground bg-foreground text-background hover:bg-foreground/90 hover:text-background' : undefined}
              onClick={() => setChartMode(mode.value)}
              aria-pressed={chartMode === mode.value}
            >
              {mode.label}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        <div ref={chartContainerRef} className="h-80 w-full" data-testid="usage-period-chart">
          {chartWidth > 0 ? (
            <BarChart width={chartWidth} height={320} data={chartData} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                minTickGap={16}
                tickMargin={10}
              />
              <YAxis
                tickFormatter={formatCompactCount}
                tickLine={false}
                axisLine={false}
                width={52}
              />
              <Tooltip
                cursor={{ fill: 'var(--muted)', opacity: 0.45 }}
                formatter={(value, name) => [formatCount(Number(value)), chartSeriesLabels[String(name)] ?? String(name)]}
                labelFormatter={(_label, payload) => payload[0]?.payload.fullLabel ?? ''}
              />
              <Legend />
              {chartMode === 'conversations' ? (
                <Bar dataKey="conversations" name={chartSeriesLabels.conversations} fill="var(--foreground)" radius={[4, 4, 0, 0]} />
              ) : null}
              {chartMode === 'messages' ? (
                <>
                  <Bar dataKey="userMessages" name={chartSeriesLabels.userMessages} stackId="messages" fill="var(--foreground)" radius={[0, 0, 4, 4]} />
                  <Bar dataKey="assistantMessages" name={chartSeriesLabels.assistantMessages} stackId="messages" fill="var(--muted-foreground)" radius={[4, 4, 0, 0]} />
                </>
              ) : null}
              {chartMode === 'tokens' ? (
                <>
                  <Bar dataKey="inputTokens" name={chartSeriesLabels.inputTokens} stackId="tokens" fill="var(--foreground)" radius={[0, 0, 4, 4]} />
                  <Bar dataKey="outputTokens" name={chartSeriesLabels.outputTokens} stackId="tokens" fill="var(--muted-foreground)" radius={[4, 4, 0, 0]} />
                </>
              ) : null}
            </BarChart>
          ) : null}
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

  const updateQuery = (patch: Partial<UsageTrendQueryState>) => {
    setQuery((current) => ({ ...current, ...patch }))
  }

  // Agents are loaded for the active workspace only, so the agent filter is
  // scoped to that workspace. Switching workspaces clears any stale agent.
  const activeWorkspaceId = agents[0]?.workspaceId
  const agentFilterDisabled = isAgentFilterScopedOut(query.workspaceId, activeWorkspaceId)

  return (
    <div className="space-y-6" data-testid="usage-trends">
      <Card>
        <CardHeader>
          <CardTitle>Usage trends</CardTitle>
          <CardDescription>Conversations, messages, and succeeded token usage for the selected range.</CardDescription>
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
                onValueChange={(value) =>
                  updateQuery({
                    workspaceId: value === ALL_FILTER_VALUE ? undefined : value,
                    agentId: undefined,
                  })
                }
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
                disabled={agentFilterDisabled}
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
              {agentFilterDisabled ? (
                <p className="text-xs text-muted-foreground">Agent filtering is available for the current workspace only.</p>
              ) : null}
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
      ) : trends ? (
        <UsagePeriodChart trends={trends} />
      ) : null}
    </div>
  )
}
