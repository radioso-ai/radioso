'use client'

import { useState } from 'react'
import { Check, Copy, GitBranch } from 'lucide-react'

export const resolveDevBuildLabel = (
  nodeEnv = process.env.NODE_ENV,
  buildLabel = process.env.NEXT_PUBLIC_RADIOSO_DEV_BUILD_LABEL,
  buildId = process.env.NEXT_PUBLIC_RADIOSO_DEV_BUILD_ID,
) => {
  if (nodeEnv !== 'development') {
    return null
  }

  if (buildLabel) {
    return buildLabel
  }

  return buildId ? `dev ${buildId}` : null
}

export type DevBuildInfo = {
  branch: string
  buildId: string
  commit: string
  label: string
  worktree: string
}

export const resolveDevBuildInfo = (
  nodeEnv = process.env.NODE_ENV,
  label = process.env.NEXT_PUBLIC_RADIOSO_DEV_BUILD_LABEL,
  worktree = process.env.NEXT_PUBLIC_RADIOSO_DEV_WORKTREE,
  branch = process.env.NEXT_PUBLIC_RADIOSO_DEV_BRANCH,
  commit = process.env.NEXT_PUBLIC_RADIOSO_DEV_COMMIT,
  buildId = process.env.NEXT_PUBLIC_RADIOSO_DEV_BUILD_ID,
): DevBuildInfo | null => {
  const resolvedLabel = resolveDevBuildLabel(nodeEnv, label, buildId)

  if (!resolvedLabel) {
    return null
  }

  return {
    branch: branch ?? '',
    buildId: buildId ?? '',
    commit: commit ?? '',
    label: resolvedLabel,
    worktree: worktree ?? '',
  }
}

const buildCopyText = (info: DevBuildInfo) => [
  info.label,
  info.worktree ? `worktree: ${info.worktree}` : null,
  info.branch ? `branch: ${info.branch}` : null,
  info.commit ? `commit: ${info.commit}` : null,
  info.buildId ? `build: ${info.buildId}` : null,
].filter(Boolean).join('\n')

export function DevBuildBadge() {
  const info = resolveDevBuildInfo()
  const [copied, setCopied] = useState(false)

  if (!info) {
    return null
  }

  const copyText = buildCopyText(info)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(copyText)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div
      className="group fixed right-2 top-2 z-[2147483647]"
      data-testid="dev-build-badge"
    >
      <button
        type="button"
        aria-label={`Show dev build details: ${info.label}`}
        className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background/95 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:border-muted-foreground/50 hover:text-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
      >
        <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <div className="invisible absolute right-0 top-7 w-72 translate-y-1 rounded-md border border-border bg-popover p-3 text-popover-foreground opacity-0 shadow-lg transition duration-150 group-hover:visible group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:visible group-focus-within:translate-y-0 group-focus-within:opacity-100">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <div className="text-xs font-medium leading-none">Dev build</div>
            <div className="mt-1 font-mono text-[11px] leading-4 text-muted-foreground">{info.label}</div>
          </div>
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            aria-label={copied ? 'Copied dev build details' : 'Copy dev build details'}
            title={copied ? 'Copied' : 'Copy'}
          >
            {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>
        <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1.5 font-mono text-[11px] leading-4">
          <dt className="text-muted-foreground">worktree</dt>
          <dd className="truncate" title={info.worktree}>{info.worktree || 'unknown'}</dd>
          <dt className="text-muted-foreground">branch</dt>
          <dd className="truncate" title={info.branch}>{info.branch || 'unknown'}</dd>
          <dt className="text-muted-foreground">commit</dt>
          <dd className="truncate" title={info.commit}>{info.commit || 'unknown'}</dd>
          <dt className="text-muted-foreground">build</dt>
          <dd className="truncate" title={info.buildId}>{info.buildId || 'unknown'}</dd>
        </dl>
      </div>
    </div>
  )
}
