// The browser reports every unhandled error it sees, and some pages see hundreds at
// once: a script injected into the frame can reject a promise per call with a
// plain string. The limiter holds back an error it admitted within the repeat
// window and admits at most a few distinct errors per rolling minute, so a burst
// costs a handful of beacons while a tab left open for days keeps reporting.
export const FRONTEND_ERROR_REPEAT_WINDOW_MS = 10 * 60_000
export const FRONTEND_ERROR_RATE_WINDOW_MS = 60_000
export const FRONTEND_ERROR_REPORTS_PER_RATE_WINDOW = 10

interface FrontendErrorReportIdentity {
  errorType: string
  errorClass?: string
  message: string
  path?: string
}

interface FrontendErrorReportLimiter {
  admit(report: FrontendErrorReportIdentity): boolean
  /** Errors still inside their repeat window; bounded by the rate cap. */
  trackedErrorCount(): number
}

interface FrontendErrorReportLimiterOptions {
  now?: () => number
  repeatWindowMs?: number
  rateWindowMs?: number
  maxReportsPerRateWindow?: number
}

const identityKey = (report: FrontendErrorReportIdentity): string => JSON.stringify([
  report.errorType,
  report.errorClass ?? null,
  report.message,
  report.path ?? null,
])

export const createFrontendErrorReportLimiter = ({
  now = Date.now,
  repeatWindowMs = FRONTEND_ERROR_REPEAT_WINDOW_MS,
  rateWindowMs = FRONTEND_ERROR_RATE_WINDOW_MS,
  maxReportsPerRateWindow = FRONTEND_ERROR_REPORTS_PER_RATE_WINDOW,
}: FrontendErrorReportLimiterOptions = {}): FrontendErrorReportLimiter => {
  // Both collections are in admission order, because an entry is only written when
  // its error is admitted. Pruning can therefore stop at the first live entry.
  const lastAdmittedAtByKey = new Map<string, number>()
  const recentAdmissionTimes: number[] = []

  const prune = (at: number) => {
    for (const [key, admittedAt] of lastAdmittedAtByKey) {
      if (at - admittedAt < repeatWindowMs) break
      lastAdmittedAtByKey.delete(key)
    }
    while (recentAdmissionTimes.length > 0 && at - recentAdmissionTimes[0] >= rateWindowMs) {
      recentAdmissionTimes.shift()
    }
  }

  return {
    admit(report) {
      const at = now()
      prune(at)

      const key = identityKey(report)
      if (lastAdmittedAtByKey.has(key) || recentAdmissionTimes.length >= maxReportsPerRateWindow) {
        return false
      }

      lastAdmittedAtByKey.set(key, at)
      recentAdmissionTimes.push(at)
      return true
    },
    trackedErrorCount: () => lastAdmittedAtByKey.size,
  }
}
