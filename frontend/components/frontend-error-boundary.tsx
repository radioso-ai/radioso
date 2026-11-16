'use client'

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'

import {
  BeaconFrontendErrorSink,
  createFrontendErrorReporter,
  type FrontendErrorReporter,
} from '@/lib/frontend-errors'
import { API_BASE } from '@/lib/api-client'
import { planChunkLoadRecovery } from '@/lib/chunk-load-recovery'

interface FrontendErrorBoundaryProps {
  children: ReactNode
  reporter?: FrontendErrorReporter
  /** Loads `url` in place of the current page. Defaults to `window.location.replace`. */
  reloadFrame?: (url: string) => void
}

interface FrontendErrorBoundaryInnerProps extends FrontendErrorBoundaryProps {
  resetKey: string
}

interface FrontendErrorBoundaryState {
  hasError: boolean
  /** Set when the failure was a missing chunk and a reload is the recovery: the fallback stays hidden. */
  reloadUrl: string | null
}

let defaultReporter: FrontendErrorReporter | null = null

const createDefaultReporter = (): FrontendErrorReporter => {
  defaultReporter ??= createFrontendErrorReporter({
    sinks: [
      new BeaconFrontendErrorSink({
        endpoint: `${API_BASE}/observability/frontend-errors`,
      }),
    ],
  })
  return defaultReporter
}

const currentPath = (): string | undefined => {
  if (typeof window === 'undefined') {
    return undefined
  }
  return `${window.location.pathname}${window.location.search}`
}

const currentSource = (): 'frontend' | 'embed' => (
  typeof window !== 'undefined' && (
    window.location.pathname === '/embed-frame' || window.location.pathname.startsWith('/embed/')
  ) ? 'embed' : 'frontend'
)

const defaultReloadFrame = (url: string): void => {
  window.location.replace(url)
}

export class FrontendErrorBoundaryInner extends Component<FrontendErrorBoundaryInnerProps, FrontendErrorBoundaryState> {
  state: FrontendErrorBoundaryState = {
    hasError: false,
    reloadUrl: null,
  }

  private readonly reporter: FrontendErrorReporter

  private reloadStarted = false

  constructor(props: FrontendErrorBoundaryInnerProps) {
    super(props)
    this.reporter = props.reporter ?? createDefaultReporter()
  }

  // One reload is enough however many render errors the old page raises before the navigation lands.
  private readonly startReload = (url: string): void => {
    if (this.reloadStarted) return
    this.reloadStarted = true
    const reloadFrame = this.props.reloadFrame ?? defaultReloadFrame
    reloadFrame(url)
  }

  private readonly handleWindowError = (event: ErrorEvent) => {
    void this.reporter.report({
      errorType: 'frontend.runtime.unhandled',
      error: event.error,
      message: event.message,
      stack: event.error instanceof Error ? event.error.stack : undefined,
      path: currentPath(),
      source: currentSource(),
    })
  }

  private readonly handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    void this.reporter.report({
      errorType: 'frontend.promise.unhandled',
      error: event.reason,
      path: currentPath(),
      source: currentSource(),
    })
  }

  static getDerivedStateFromError(error: unknown): FrontendErrorBoundaryState {
    const plan = typeof window === 'undefined'
      ? null
      : planChunkLoadRecovery({ error, href: window.location.href, now: Date.now() })
    return { hasError: true, reloadUrl: plan?.kind === 'reload' ? plan.url : null }
  }

  componentDidMount(): void {
    window.addEventListener('error', this.handleWindowError)
    window.addEventListener('unhandledrejection', this.handleUnhandledRejection)
  }

  componentDidUpdate(previousProps: FrontendErrorBoundaryInnerProps): void {
    if (previousProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false, reloadUrl: null })
    }
  }

  // Only a render that hit a missing chunk reloads: deploy skew, the UI is already lost, and the
  // reload is the fix, so it is not reported. A chunk that fails in the background (window error or
  // unhandled rejection) leaves the page working, so it is reported like any other failure and the
  // page, with whatever the person has typed into it, stays.
  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    if (this.state.reloadUrl !== null) {
      this.startReload(this.state.reloadUrl)
      return
    }
    void this.reporter.report({
      errorType: 'frontend.react.unhandled',
      error,
      componentStack: errorInfo.componentStack ?? undefined,
      path: currentPath(),
      source: currentSource(),
    })
  }

  componentWillUnmount(): void {
    window.removeEventListener('error', this.handleWindowError)
    window.removeEventListener('unhandledrejection', this.handleUnhandledRejection)
  }

  render() {
    if (this.state.hasError) {
      if (this.state.reloadUrl !== null) {
        return null
      }
      return (
        <main className="min-h-screen bg-background text-foreground">
          <div className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6">
            <h1 className="text-2xl font-semibold tracking-normal">Something went wrong</h1>
            <p className="mt-3 text-sm text-muted-foreground">Refresh the page to continue.</p>
            <button
              className="mt-6 w-fit rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted"
              type="button"
              onClick={() => this.setState({ hasError: false, reloadUrl: null })}
            >
              Try again
            </button>
          </div>
        </main>
      )
    }

    return this.props.children
  }
}

export function FrontendErrorBoundary(props: FrontendErrorBoundaryProps) {
  const pathname = usePathname()
  return <FrontendErrorBoundaryInner {...props} resetKey={pathname} />
}
