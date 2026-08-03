'use client'

import { useEffect, useState } from 'react'

import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { LogoSpinner } from '@/components/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { UsageDetailsView } from '@/components/dashboard/usage-details-view'
import { UsageTrendsView } from '@/components/dashboard/usage-trends-view'
import { enterpriseUsageApi, workspaceApi, type AccountUsageSummary, type WorkspaceSummaryResponse } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { editionController } from '@/lib/edition-controller'
import { formatBytes } from '@/lib/format-bytes'

const numberFormatter = new Intl.NumberFormat()

const formatCount = (value: number) => numberFormatter.format(value)

const formatDate = (value: string) => (
  new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value))
)

const formatUsageLimit = (value: number | null) => (value === null ? 'Unlimited' : formatCount(value))
const formatByteLimit = (value: number | null) => (value === null ? 'Unlimited' : formatBytes(value))
type UsageViewTab = 'overview' | 'ai-usage'

const usagePercent = (used: number, limit: number | null) => {
  if (limit === null || limit === 0) {
    return null
  }

  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)))
}

function UsageMeter({
  label,
  used,
  limit,
  caption,
  unit = 'count',
}: {
  label: string
  used: number
  limit: number | null
  caption?: string
  unit?: 'count' | 'bytes'
}) {
  const percent = usagePercent(used, limit)
  const formatValue = unit === 'bytes' ? formatBytes : formatCount

  return (
    <Card>
      <CardHeader>
        <CardTitle>{label}</CardTitle>
        <CardDescription>{caption ?? 'Current account usage'}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div className="text-3xl font-semibold tracking-normal text-foreground">
            {formatValue(used)}
          </div>
          {limit === null ? null : (
            <div className="text-sm text-muted-foreground">
              of {formatValue(limit)}
            </div>
          )}
        </div>
        {percent === null ? null : (
          <div className="space-y-2">
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-foreground transition-all"
                style={{ width: `${percent}%` }}
              />
            </div>
            <div className="text-xs text-muted-foreground">{percent}% used</div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function UsageView({ accountId }: { accountId: string }) {
  const usageLimitsEnabled = editionController.canUseEnterpriseUsageLimits()
  const [activeTab, setActiveTab] = useState<UsageViewTab>('overview')
  const [usage, setUsage] = useState<AccountUsageSummary | null>(null)
  const [workspaceSummary, setWorkspaceSummary] = useState<WorkspaceSummaryResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true

    const loadUsage = async () => {
      setIsLoading(true)
      setError(null)
      try {
        if (usageLimitsEnabled) {
          const response = await enterpriseUsageApi.getAccountUsage()
          if (!active) return
          setUsage(response)
          setWorkspaceSummary(null)
          return
        }

        const response = await workspaceApi.getSummary()
        if (!active) return
        setWorkspaceSummary(response)
        setUsage(null)
      } catch (nextError) {
        if (!active) return
        setError(getApiErrorMessage(nextError, 'Failed to load usage.'))
      } finally {
        if (active) {
          setIsLoading(false)
        }
      }
    }

    void loadUsage()
    return () => {
      active = false
    }
  }, [usageLimitsEnabled])

  return (
    <DashboardPage
      title="Usage"
      description={usageLimitsEnabled ? 'Limits, current totals, trends, and detailed AI usage for this account.' : 'Current workspace usage, account trends, and detailed AI usage.'}
      contentClassName="p-6"
    >
      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as UsageViewTab)} className="gap-6">
        <TabsList aria-label="Usage view">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="ai-usage">AI usage</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          {isLoading ? (
            <div className="flex h-full items-center justify-center">
              <LogoSpinner imageClassName="h-7 w-7" />
            </div>
          ) : error ? (
            <Card>
              <CardHeader>
                <CardTitle>Usage unavailable</CardTitle>
                <CardDescription>{error}</CardDescription>
              </CardHeader>
            </Card>
          ) : usageLimitsEnabled && usage ? (
            <div className="space-y-6">
              <div className="grid gap-6 lg:grid-cols-2">
                <UsageMeter
                  label="Monthly answers"
                  used={usage.monthlyAnswers.used}
                  limit={usage.monthlyAnswers.limit}
                  caption="Assistant and retrieval answers used this month."
                />
                <UsageMeter
                  label="Indexed storage"
                  unit="bytes"
                  used={usage.storedIndexedBytes.used}
                  limit={usage.storedIndexedBytes.limit}
                  caption="Content Radioso keeps searchable."
                />
                <UsageMeter
                  label="Monthly indexed content"
                  unit="bytes"
                  used={usage.monthlyIndexedBytes.used}
                  limit={usage.monthlyIndexedBytes.limit}
                  caption="Content added or refreshed this month."
                />
                <UsageMeter
                  label="Stored documents"
                  used={usage.storedDocuments.used}
                  limit={usage.storedDocuments.limit}
                  caption="Document count guardrail."
                />
              </div>

              {usage?.profile ? (
                <Card>
                  <CardHeader>
                    <CardTitle>{usage.profile.displayName}</CardTitle>
                    <CardDescription>
                      Limits: {formatUsageLimit(usage.monthlyAnswers.limit)} monthly answers,{' '}
                      {formatByteLimit(usage.storedIndexedBytes.limit)} indexed storage,{' '}
                      {formatByteLimit(usage.monthlyIndexedBytes.limit)} monthly indexed content,{' '}
                      {formatUsageLimit(usage.storedDocuments.limit)} stored documents
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-4 text-sm text-muted-foreground sm:grid-cols-2">
                    {usage.monthlyAnswers.limit === null ? null : (
                      <div>
                        <div className="font-medium text-foreground">Monthly answer reset</div>
                        <div>{formatDate(usage.monthlyAnswers.resetAt)}</div>
                      </div>
                    )}
                    <div>
                      <div className="font-medium text-foreground">Current period</div>
                      <div>Started {formatDate(usage.monthlyAnswers.periodStart)}</div>
                    </div>
                  </CardContent>
                </Card>
              ) : null}

              <UsageTrendsView />
            </div>
          ) : workspaceSummary ? (
            <div className="space-y-6">
              <div className="grid gap-6 lg:grid-cols-2">
                <UsageMeter
                  label="Conversations"
                  used={workspaceSummary.conversationCount}
                  limit={null}
                  caption="Saved conversations in this workspace."
                />
                <UsageMeter
                  label="Stored documents"
                  used={workspaceSummary.documentCount}
                  limit={null}
                  caption="Documents currently stored in this workspace."
                />
                <UsageMeter
                  label="Ready documents"
                  used={workspaceSummary.readyDocumentCount}
                  limit={null}
                  caption="Documents available for retrieval."
                />
                <UsageMeter
                  label="Pending documents"
                  used={workspaceSummary.pendingDocumentCount}
                  limit={null}
                  caption="Documents waiting for processing."
                />
              </div>

              <UsageTrendsView />
            </div>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Usage unavailable</CardTitle>
                <CardDescription>No usage data is available.</CardDescription>
              </CardHeader>
            </Card>
          )}
        </TabsContent>
        <TabsContent value="ai-usage">
          <UsageDetailsView accountId={accountId} />
        </TabsContent>
      </Tabs>
    </DashboardPage>
  )
}
