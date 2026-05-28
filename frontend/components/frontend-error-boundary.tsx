'use client'

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'

import {
  BeaconFrontendErrorSink,
  createFrontendErrorReporter,
  type FrontendErrorReporter,
} from '@/lib/frontend-errors'
import { API_BASE } from '@/lib/api-client'

interface FrontendErrorBoundaryProps {
  children: ReactNode
  reporter?: FrontendErrorReporter
}

interface FrontendErrorBoundaryInnerProps extends FrontendErrorBoundaryProps {
  resetKey: string
}

interface FrontendErrorBoundaryState {
  hasError: boolean
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

export class FrontendErrorBoundaryInner extends Component<FrontendErrorBoundaryInnerProps, FrontendErrorBoundaryState> {
  state: FrontendErrorBoundaryState = {
    hasError: false,
  }

  private readonly reporter: FrontendErrorReporter

  constructor(props: FrontendErrorBoundaryInnerProps) {
    super(props)
    this.reporter = props.reporter ?? createDefaultReporter()
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

  static getDerivedStateFromError(): FrontendErrorBoundaryState {
    return { hasError: true }
  }

  componentDidMount(): void {
    window.addEventListener('error', this.handleWindowError)
    window.addEventListener('unhandledrejection', this.handleUnhandledRejection)
  }

  componentDidUpdate(previousProps: FrontendErrorBoundaryInnerProps): void {
    if (previousProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false })
    }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
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
      return (
        <main className="min-h-screen bg-background text-foreground">
          <div className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6">
            <h1 className="text-2xl font-semibold tracking-normal">Something went wrong</h1>
            <p className="mt-3 text-sm text-muted-foreground">Refresh the page to continue.</p>
            <button
              className="mt-6 w-fit rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted"
              type="button"
              onClick={() => this.setState({ hasError: false })}
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
