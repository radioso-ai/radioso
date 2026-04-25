'use client'

import { type ReactNode } from 'react'
import { Check, FileText, LoaderCircle, MessageSquareText } from 'lucide-react'
import { useRouter } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { buildDashboardHref } from '@/lib/dashboard-routes'
import { type WorkspaceOnboardingState } from '@/lib/onboarding'
import { useWorkspace } from '@/lib/workspace-context'
import { cn } from '@/lib/utils'

interface FirstRunExperienceProps {
  accountId: string
  onboarding: WorkspaceOnboardingState
}

function StepRow({
  number,
  title,
  description,
  tone = 'upcoming',
  action,
}: {
  number: number
  title: string
  description: string
  tone?: 'active' | 'done' | 'upcoming'
  action?: ReactNode
}) {
  const badgeClassName =
    tone === 'done'
      ? 'border-primary/30 bg-primary/10 text-primary'
      : tone === 'active'
        ? 'border-foreground/20 bg-foreground text-background'
        : 'border-border bg-muted/40 text-muted-foreground'

  return (
    <li className="grid grid-cols-[32px_1fr] gap-4 border-b border-border/70 py-5 last:border-b-0">
      <div
        className={cn(
          'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-sm font-medium',
          badgeClassName,
        )}
      >
        {tone === 'done' ? <Check className="h-3.5 w-3.5" /> : number}
      </div>
      <div className="min-w-0 space-y-1">
        <p className="text-[15px] font-medium text-foreground">{title}</p>
        <p className={cn('text-[13px] leading-6 text-muted-foreground', tone === 'upcoming' && 'text-muted-foreground/80')}>
          {description}
        </p>
        {action ? (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {action}
          </div>
        ) : null}
      </div>
    </li>
  )
}

function ProgressHeader({
  completedCount,
}: {
  completedCount: number
}) {
  const progressWidth = `${Math.max(0, Math.min(100, (completedCount / 3) * 100))}%`

  return (
    <div className="flex items-center gap-3">
      <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-foreground transition-all" style={{ width: progressWidth }} />
      </div>
      <span className="whitespace-nowrap text-xs text-muted-foreground">
        {completedCount} of 3 complete
      </span>
    </div>
  )
}

export function FirstRunExperience({ accountId, onboarding }: FirstRunExperienceProps) {
  const router = useRouter()
  const { activeWorkspace, activeWorkspaceId } = useWorkspace()
  const isProcessing = onboarding.isImportingSampleDocs || onboarding.hasPendingDocuments
  const isReady = onboarding.hasReadyDocuments && !onboarding.hasPendingDocuments
  const hasDocuments = onboarding.hasDocuments
  const hasSampleDocuments = onboarding.sampleDocumentsImported
  const completedCount = Number(hasDocuments) + Number(isReady)

  const documentsHref = buildDashboardHref(accountId, {
    section: 'documents',
    workspaceId: activeWorkspaceId ?? undefined,
    workspacePublicRouteKey: activeWorkspace?.publicRouteKey,
  })

  const addDocumentsDescription = hasDocuments
    ? hasSampleDocuments
      ? 'Your workspace has Radioso docs. Open the list to review them or upload your own.'
      : 'Your workspace has documents. Open the list to review them or upload more.'
    : 'Upload your own files, or try a small set of Radioso docs first.'

  const processingDescription = isReady
    ? 'At least one document is processed and chat is ready.'
    : isProcessing
      ? 'Your documents are being indexed. Chat unlocks as soon as one is ready.'
      : 'Processing starts after you add your first document.'

  const chatDescription = isReady
    ? 'Open chat and ask the first question.'
    : 'Available once a document finishes processing.'

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[560px] flex-1 items-center px-6 py-8">
        <div className="w-full py-8">
          <div className="mb-5 space-y-1.5">
            <h1 className="text-[20px] font-medium text-foreground">Get started with Radioso</h1>
            <p className="text-sm leading-6 text-muted-foreground">
              Upload documents and Radioso will let you ask questions grounded in your content.
            </p>
          </div>

          <div className="mb-7">
            <ProgressHeader completedCount={completedCount} />
          </div>

          <ol className="rounded-xl border border-border/70 bg-background px-5">
            <StepRow
              number={1}
              title="Add documents"
              description={addDocumentsDescription}
              tone={hasDocuments ? 'done' : 'active'}
              action={
                <>
                  <Button size="sm" variant="outline" onClick={() => router.push(documentsHref)}>
                    <FileText className="mr-2 h-4 w-4" />
                    {hasDocuments ? 'Open documents' : 'Upload documents'}
                  </Button>
                  {!hasDocuments ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={onboarding.isImportingSampleDocs}
                      onClick={() => {
                        void onboarding.importSampleDocs()
                      }}
                    >
                      <FileText className="mr-2 h-4 w-4" />
                      {onboarding.isImportingSampleDocs ? 'Adding Radioso docs...' : 'Try Radioso docs'}
                    </Button>
                  ) : null}
                </>
              }
            />

            <StepRow
              number={2}
              title="Wait for processing"
              description={processingDescription}
              tone={isReady ? 'done' : hasDocuments ? 'active' : 'upcoming'}
              action={
                isProcessing ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    Processing...
                  </span>
                ) : null
              }
            />

            <StepRow
              number={3}
              title="Ask a question"
              description={chatDescription}
              tone={isReady ? 'active' : 'upcoming'}
              action={
                isReady ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      onboarding.markCompleted()
                      router.push(buildDashboardHref(accountId, {
                        section: 'chat',
                        workspaceId: activeWorkspaceId ?? undefined,
                        workspacePublicRouteKey: activeWorkspace?.publicRouteKey,
                      }))
                    }}
                  >
                    <MessageSquareText className="mr-2 h-4 w-4" />
                    Open chat
                  </Button>
                ) : null
              }
            />
          </ol>
        </div>
      </div>
    </div>
  )
}
