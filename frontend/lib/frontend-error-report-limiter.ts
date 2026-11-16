// The browser reports every unhandled error it sees, and some pages see hundreds at
// once: a script injected into the frame can reject a promise per call with a
// plain string. One page load reports each distinct error once and at most
// FRONTEND_ERROR_REPORTS_PER_PAGE_MAX errors in total, so a burst from one visitor
// costs a handful of beacons rather than flooding the relay's rate limit.
export const FRONTEND_ERROR_REPORTS_PER_PAGE_MAX = 10

interface FrontendErrorReportIdentity {
  errorType: string
  errorClass?: string
  message: string
  path?: string
}

interface FrontendErrorReportLimiter {
  admit(report: FrontendErrorReportIdentity): boolean
}

const identityKey = (report: FrontendErrorReportIdentity): string => JSON.stringify([
  report.errorType,
  report.errorClass ?? null,
  report.message,
  report.path ?? null,
])

export const createFrontendErrorReportLimiter = (
  maxReports: number = FRONTEND_ERROR_REPORTS_PER_PAGE_MAX,
): FrontendErrorReportLimiter => {
  const admitted = new Set<string>()

  return {
    admit(report) {
      const key = identityKey(report)
      if (admitted.has(key) || admitted.size >= maxReports) {
        return false
      }
      admitted.add(key)
      return true
    },
  }
}
