export interface UsageDetailsQueryState {
  from: string
  to: string
  workspaceId?: string
}

const numberFormatter = new Intl.NumberFormat()
const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/

const toDateOnly = (date: Date): string => date.toISOString().slice(0, 10)

const isDateOnly = (value: string | null): value is string => {
  if (!value || !dateOnlyPattern.test(value)) {
    return false
  }

  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && toDateOnly(parsed) === value
}

export const defaultUsageDetailsQuery = (now: Date = new Date()): UsageDetailsQueryState => {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const start = new Date(end.getTime())
  start.setUTCDate(start.getUTCDate() - 29)
  return {
    from: toDateOnly(start),
    to: toDateOnly(end),
  }
}

export const parseUsageDetailsQuery = (
  searchParams: Pick<URLSearchParams, 'get'> | null | undefined,
): UsageDetailsQueryState | undefined => {
  const from = searchParams?.get('usageFrom') ?? null
  const to = searchParams?.get('usageTo') ?? null
  if (!isDateOnly(from) || !isDateOnly(to) || from > to) {
    return undefined
  }

  const workspaceId = searchParams?.get('usageWorkspace') ?? null
  return {
    from,
    to,
    ...(workspaceId ? { workspaceId } : {}),
  }
}

export const readUsageDetailsQuery = (
  searchParams: Pick<URLSearchParams, 'get'>,
  now: Date = new Date(),
): UsageDetailsQueryState => parseUsageDetailsQuery(searchParams) ?? defaultUsageDetailsQuery(now)

export const writeUsageDetailsQuery = (
  searchParams: URLSearchParams,
  query: UsageDetailsQueryState,
): URLSearchParams => {
  const next = new URLSearchParams(searchParams)
  next.set('usageFrom', query.from)
  next.set('usageTo', query.to)
  if (query.workspaceId) {
    next.set('usageWorkspace', query.workspaceId)
  } else {
    next.delete('usageWorkspace')
  }
  return next
}

export const formatUsageTokenCount = (value: number | null): string => (
  value === null ? '—' : numberFormatter.format(value)
)

export const formatUsageOutput = ({
  completion,
  visibleOutput,
  reasoningCoverage = 'unavailable',
}: {
  completion: number | null
  visibleOutput: number | null
  reasoningCoverage?: 'complete' | 'partial' | 'unavailable'
}): { tokens: number | null; detail: string | null } => {
  if (visibleOutput !== null) {
    return {
      tokens: visibleOutput,
      detail: completion === null ? null : `Completion ${formatUsageTokenCount(completion)}`,
    }
  }

  if (completion === null) {
    return { tokens: null, detail: null }
  }

  return {
    tokens: completion,
    detail: reasoningCoverage === 'partial'
      ? 'Reasoning only partially reported'
      : 'Reasoning not reported separately',
  }
}

export const formatLlmCallCount = ({ total, failed }: { total: number; failed: number }): string => (
  failed > 0 ? `${total} (${failed} failed)` : String(total)
)
